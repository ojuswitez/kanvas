import * as fs from 'fs';
const file = fs.readFileSync('./redacted_redacted.yaml', 'utf8');
import { parse } from 'yaml';
import { evalExpr, execExpr } from './expr';
import { Nft } from './types';
import * as log from 'log';

interface StateTransition {}

interface State {
  transitions: [
    {
      next_state: string;
      when: string;
      do?: string;
    },
  ];
  mutables: [
    {
      attributes: string[];
      by_roles: string[];
    },
  ];
}

export class StateTransitionMachine {
  attrTypes: any = {};
  states: any = {};

  constructor(filepath: string) {
    const parsed = parse(file);

    for (const attr in parsed.attributes) {
      this.attrTypes[attr] = parsed.attributes[attr];
    }

    for (const stateName in parsed.states) {
      const st = parsed.states[stateName];
      this.states[stateName] = {
        transitions: st.state_transitions,
        mutables: st.mutables,
      };
    }
  }

  tryAttributeSet(nft: Nft, role: string, attr: string, v?: string) {
    const st = this.states[nft.state];
    const isAllowed =
      st.mutables.findIndex(
        (m: any) =>
          m.attributes.some((mutableAttr: string) => attr === mutableAttr) &&
          m.by_roles.some((allowedRole: string) => role == allowedRole),
      ) !== -1;
    if (!isAllowed) {
      throw `attribute '${attr}' is not allowed to be set by user of role '${role}' for nft with state '${nft.state}'`;
    }

    if (typeof v === 'undefined') {
      delete nft.attributes[attr];
      return;
    }
    nft.attributes[attr] = JSON.parse(v);
    log.info(`type of attribute '${attr}' is '${typeof nft.attributes[attr]}'`);
  }

  // greedily move nft if possible to a new state
  // returns true if moved and adjusts nft in memory
  // returns false if not moved
  tryMoveNft(nft: Nft): boolean {
    const st = this.states[nft.state];

    for (const transition of st.transitions) {
      if (evalExpr<boolean>(nft, transition.when, false)) {
        nft.state = transition.next_state;
        if (typeof transition.do !== 'undefined') {
          execExpr(nft, transition.do);
        }
        return true;
      }
    }

    return false;
  }
}
