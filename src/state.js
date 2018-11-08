// @flow

import fs from "fs-extra";
import invariant from "invariant";
import { Set as ImmSet, List as ImmList } from "immutable";

export type Address = string;
export type State = {|
  markets: ImmSet<Address>
|};

export function getInitialState(): State {
  return {
    markets: ImmSet()
  };
}

export function serializeState(state: State): string {
  return JSON.stringify({
    markets: ImmList(state.markets)
      .sort()
      .toArray()
  });
}

export function deserializeState(blob: string): State {
  const { markets } = JSON.parse(blob);
  const state = {
    markets: ImmSet(markets)
  };
  invariant(serializeState(state) === blob, "bad serde");
  return state;
}

export async function loadState(path: string): Promise<State> {
  const exists = await fs.pathExists(path);

  if (exists) {
    const string = await fs.readFile(path);
    return deserializeState(string);
  } else {
    return getInitialState();
  }
}
