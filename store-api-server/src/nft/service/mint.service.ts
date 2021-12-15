import { Injectable, Inject } from '@nestjs/common';
import { PG_CONNECTION, MINTER_ADDRESS } from '../../constants';
import { NftEntity } from 'src/nft/entity/nft.entity';
import { IpfsService } from 'src/nft/service/ipfs.service';

interface Command {
  handler: string;
  name: string;
  args: {
    token_id: number;
    to_address: string;
    amount: number;

    from_address?: string;
    metadata_ipfs?: string;
  };
}

@Injectable()
export class MintService {
  ipfsService: IpfsService;

  constructor() {
    this.ipfsService = new IpfsService();
  }

  async transfer(dbTx: any, nft: NftEntity, buyer: string) {
    if (!(await this.#isNftSubmitted(dbTx, nft))) {
      await this.#mint(dbTx, nft);
    }
    const cmd = {
      handler: 'nft',
      name: 'transfer',
      args: {
        token_id: nft.id,
        from_address: MINTER_ADDRESS,
        to_address: 'tz1QyKEvd16HRssMJdBXxDLrtV7uQUR7EYjk', // buyer,
        amount: 1,
      },
    };
    await this.#insertCommand(dbTx, cmd);
  }

  async #mint(dbTx: any, nft: NftEntity) {
    const metadataIpfs = await this.ipfsService.uploadNft(nft);
    const cmd = {
      handler: 'nft',
      name: 'create_and_mint',
      args: {
        token_id: nft.id,
        to_address: MINTER_ADDRESS,
        metadata_ipfs: metadataIpfs,
        amount: nft.editionsSize,
      },
    };

    await this.#insertCommand(dbTx, cmd);
  }

  async #insertCommand(dbTx: any, cmd: Command) {
    await dbTx.query(
      `
INSERT INTO peppermint.operations (
  originator, command
)
VALUES (
  $1, $2
)
`,
      [MINTER_ADDRESS, cmd],
    );
  }

  async #isNftSubmitted(dbTx: any, nft: NftEntity): Promise<boolean> {
    const qryRes = await dbTx.query(
      `
SELECT 1
FROM onchain_kanvas."storage.token_metadata_live"
WHERE idx_assets_nat::INTEGER = $1

UNION ALL

SELECT 1
FROM peppermint.operations
WHERE (command->'handler')::TEXT = 'nft'
  AND (command->'name')::TEXT = 'create_and_mint'
  AND (command->'args'->'token_id')::INTEGER = $1
  AND state != 'rejected'
`,
      [nft.id],
    );
    return qryRes.rowCount > 0;
  }
}
