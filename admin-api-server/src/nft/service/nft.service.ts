import {
  Logger,
  HttpException,
  HttpStatus,
  Injectable,
  Inject,
} from '@nestjs/common';
import { PG_CONNECTION, FILE_PREFIX } from 'src/constants';
import { DbPool } from 'src/db.module';
import { STMResultStatus, StateTransitionMachine, Actor } from 'roles_stm';
import { User } from 'src/user/entities/user.entity';
import { NftEntity, NftUpdate } from '../entities/nft.entity';
import { NftFilterParams, parseStringArray } from '../params';
import { RoleService } from 'src/role/role.service';
import { S3Service } from './s3.service';
import { Lock } from 'async-await-mutex-lock';
import { QueryParams } from 'src/types';
import {
  convertToSnakeCase,
  prepareFilterClause,
  prepareNftFilterClause,
} from 'src/utils';
const fs = require('fs');

@Injectable()
export class NftService {
  stm: StateTransitionMachine;
  nftLock: Lock<number>;
  CONTENT_TYPE = 'content_uri';
  TOP_LEVEL_IDENTIFIERS = ['id', 'state', 'created_at', 'updated_at'];
  DELETABLE_IN_STATES = ['creation', 'setup_nft'];

  constructor(
    @Inject(S3Service) private s3Service: S3Service,
    @Inject(PG_CONNECTION) private db: DbPool,
    private readonly roleService: RoleService,
  ) {
    const stmConfigFile = './config/stm_example.yaml';
    this.stm = new StateTransitionMachine(stmConfigFile);
    this.nftLock = new Lock<number>();
    fs.watch(stmConfigFile, (event: any, filename: any) => {
      if (event !== 'change') {
        return;
      }
      try {
        Logger.log('State transition machine config changed, reloading..');
        this.stm = new StateTransitionMachine(stmConfigFile);
        Logger.log('State transition machine config reloaded');
      } catch (err: any) {
        Logger.warn(
          `State transition machine config reload failed, err: ${err}`,
        );
      }
    });
  }

  getSortableFields(): string[] {
    return [
      ...this.TOP_LEVEL_IDENTIFIERS,
      ...Object.keys(this.stm.getAttributes()),
    ];
  }

  async findAll(params: NftFilterParams): Promise<NftEntity[]> {
    let orderBy = params.orderBy;
    if (
      Object.keys(this.stm.getAttributes()).some(
        (ident: string) => ident === orderBy,
      )
    ) {
      orderBy = `attributes->>'${orderBy}'`;
    }
    const qryRes = await this.db.query(
      `
WITH attr AS (
  SELECT
    nft_id,
    JSONB_OBJECT(ARRAY_AGG(name), ARRAY_AGG(value)) AS attributes
  FROM nft_attribute
  WHERE ($2::INTEGER[] IS NULL OR nft_id = ANY($2::INTEGER[]))
  GROUP BY nft_id
)
SELECT
  nft.id,
  nft.state,
  nft.created_by,
  nft.created_at,
  nft.updated_at,
  attr.attributes
FROM nft
LEFT JOIN attr
  ON nft.id = attr.nft_id
WHERE ($1::TEXT[] IS NULL OR state = ANY($1::TEXT[]))
  AND ($2::INTEGER[] IS NULL OR id = ANY($2::INTEGER[]))
ORDER BY ${orderBy} ${params.orderDirection}
OFFSET ${params.pageOffset}
LIMIT  ${params.pageSize}
      `,
      [params.filters.nftStates, params.filters.nftIds],
    );

    if (qryRes.rowCount === 0) {
      return undefined;
    }
    return qryRes.rows.map((row: any) => {
      const nft = <NftEntity>{
        id: row['id'],
        state: row['state'],
        createdBy: row['created_by'],
        createdAt: Math.floor(row['created_at'].getTime() / 1000),
        updatedAt: Math.floor(row['updated_at'].getTime() / 1000),
        attributes: {},
      };
      for (const key of Object.keys(row['attributes'] || [])) {
        nft.attributes[key] = JSON.parse(row['attributes'][key]);
      }
      return nft;
    });
  }

  async findByIds(nftIds: number[]): Promise<NftEntity[]> {
    const filterParams = new NftFilterParams();

    filterParams.filters.nftIds = nftIds;

    return await this.findAll(filterParams);
  }

  async findOne(nftId: number): Promise<NftEntity> {
    const nfts = await this.findByIds([nftId]);

    if (nfts.length === 0) {
      throw new HttpException(`nft does not exist`, HttpStatus.BAD_REQUEST);
    }
    return nfts[0];
  }

  async getNft(user: User, nftId: number) {
    const nft = await this.findOne(nftId);
    const actor = await this.getActorForNft(user, nft);

    return {
      ...nft,
      allowedActions: this.stm.getAllowedActions(actor, nft),
    };
  }

  async getActorForNft(user: User, nft: NftEntity): Promise<Actor> {
    const roles = await this.roleService.getLabels(user.roles);
    if (nft.createdBy === user.id) {
      roles.push('creator');
    }
    return new Actor(user.id, roles);
  }

  async applyNftUpdates(
    user: User,
    nftId: number,
    nftUpdates: NftUpdate[],
  ): Promise<NftEntity> {
    await this.nftLock.acquire(nftId);
    try {
      let nfts = await this.findByIds([nftId]);
      if (typeof nfts === 'undefined') {

        nfts = [await this.#createNft(user)];
      }
      const nft = nfts[0];
      const actor = await this.getActorForNft(user, nft);

      for (let nftUpdate of nftUpdates) {
        // Check if attribute is of type content in order to upload to ipfs
        if (typeof nftUpdate.file !== 'undefined') {
          nftUpdate = await this.#uploadContent(
            user,
            nft.id,
            nftUpdate.attribute,
            nftUpdate.file,
          );
        }

        const stmRes = this.stm.tryAttributeApply(
          actor,
          nft,
          nftUpdate.attribute,
          nftUpdate.value,
        );

        if (stmRes.status != STMResultStatus.OK) {
          switch (stmRes.status) {
            case STMResultStatus.NOT_ALLOWED:
              throw new HttpException(
                stmRes.message || '',
                HttpStatus.FORBIDDEN,
              );
            default:
              throw new HttpException(
                stmRes.message || '',
                HttpStatus.INTERNAL_SERVER_ERROR,
              );
          }
        }
      }

      await this.#updateNft(user, nft);
      return await this.getNft(user, nft.id);
    } catch (err: any) {
      throw err;
    } finally {
      this.nftLock.release(nftId);
    }
  }

  async deleteNft(user: User, nftId: number) {
    await this.nftLock.acquire(nftId);
    const nft = await this.findOne(nftId);
    if (nft.createdBy !== user.id) {
      throw new HttpException(
        'no permission to delete this nft (only the creator may)',
        HttpStatus.FORBIDDEN,
      );
    }
    if (
      !this.DELETABLE_IN_STATES.some((state: string) => nft.state === state)
    ) {
      throw new HttpException(
        'no permission to delete this nft (nft is not in a state where it may still be deleted)',
        HttpStatus.FORBIDDEN,
      );
    }

    const dbTx = await this.db.connect();
    try {
      await dbTx.query(`BEGIN`);
      await dbTx.query(
        `
DELETE FROM nft_attribute
WHERE nft_id = $1
`,
        [nftId],
      );
      await dbTx.query(
        `
DELETE FROM nft
WHERE id = $1
`,
        [nftId],
      );
      await dbTx.query('COMMIT');
    } catch (err: any) {
      await dbTx.query('ROLLBACK');
      throw err;
    } finally {
      this.nftLock.release(nftId);
    }
  }

  async #uploadContent(
    user: User,
    nftId: number,
    attribute: string,
    file: any,
  ): Promise<NftUpdate> {
    // verify first that we are allowed to change the content, before uploading
    // to S3 (and potentially overwriting an earlier set content)
    const nft = await this.getNft(user, nftId);
    if (typeof nft === 'undefined') {
      throw new HttpException(`nft does not exist`, HttpStatus.BAD_REQUEST);
    }
    if (!nft.allowedActions.hasOwnProperty(attribute)) {
      throw new HttpException(
        `attribute '${attribute}' is not allowed to be set by you for nft with state '${nft.state}'`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (nft.allowedActions[attribute] != this.CONTENT_TYPE) {
      throw new HttpException(
        `attribute '${attribute}' is not of type ${this.CONTENT_TYPE}`,
        HttpStatus.UNAUTHORIZED,
      );
    }

    const fileName = `${FILE_PREFIX}_${nftId}_${attribute}`;
    // we'll simply store the uri as a pointer to the image in our own db
    const contentUri = await this.s3Service.uploadFile(file, fileName);

    return <NftUpdate>{
      attribute: attribute,
      value: JSON.stringify(contentUri),
    };
  }

  async #createNft(creator: User): Promise<NftEntity> {
    try {
      const qryRes = await this.db.query(
        `
INSERT INTO nft (
  created_by, state
)
VALUES ($1, 'creation')
RETURNING id
    `,
        [creator.id],
      );

      const test= await this.getNft(creator, qryRes.rows[0].id);
      
      return test
    } catch (err: any) {
      Logger.error(`Unable to create new nft, err: ${err}`);
      throw new HttpException(
        'Unable to create new nft',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async #updateNft(setBy: User, nft: NftEntity) {
    const attrNames = Object.keys(nft.attributes);
    const attrValues = attrNames.map((name: string) =>
      JSON.stringify(nft.attributes[name]),
    );

    const dbTx = await this.db.connect();
    try {
      await dbTx.query(`BEGIN`);
      dbTx.query(
        `
UPDATE nft
SET state = $2
WHERE id = $1
      `,
        [nft.id, nft.state],
      );
      await dbTx.query(
        `
INSERT INTO nft_attribute AS TARGET (
  nft_id, set_by, name, value
)
SELECT $1, $2, attr.name, attr.value
FROM UNNEST($3::text[], $4::text[]) attr(name, value)
ON CONFLICT ON CONSTRAINT nft_attribute_pkey DO UPDATE
SET
  value = EXCLUDED.value,
  set_at = now() AT TIME ZONE 'UTC'
WHERE TARGET.value != EXCLUDED.value
      `,
        [nft.id, setBy.id, attrNames, attrValues],
      );
      await dbTx.query(`COMMIT`);
    } catch (err: any) {
      Logger.error(`failed to update nft (id=${nft.id}), err: ${err}`);
      await dbTx.query(`ROLLBACK`);
      throw err;
    } finally {
      dbTx.release();
    }
  }
}
