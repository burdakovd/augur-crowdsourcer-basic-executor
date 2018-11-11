// @flow

import * as fs from "fs-extra";
import invariant from "invariant";
import { Map as ImmMap, List as ImmList } from "immutable";

const STATE_VERSION = 3;

export type Address = string;
export type State = {|
  version: number,
  markets: ImmMap<
    Address,
    {|
      numOutcomes: number,
      isOver: boolean,
      lastObservedFeeWindow: number,
      crowdsourcers: ImmMap<
        string,
        {|
          feeWindowID: number,
          invalid: boolean,
          numerators: ImmList<number>,
          address: Address,
          disputer: Address,
          weDisputed: boolean,
          weCollectedFees: boolean
        |}
      >
    |}
  >
|};

export function stringifyCrowdsourcerSignature(
  feeWindowID: number,
  invalid: boolean,
  numerators: ImmList<number>
): string {
  return `${feeWindowID}:${invalid.toString()}:${numerators.size}:${numerators
    .map(n => n.toString())
    .toArray()
    .join(",")}`;
}

export function getInitialState(): State {
  return {
    version: STATE_VERSION,
    markets: ImmMap()
  };
}

export function serializeState(state: State): string {
  invariant(
    state.version === STATE_VERSION,
    "do not know how to serialize this"
  );
  return JSON.stringify({
    version: state.version,
    markets: state.markets
      .map(({ numOutcomes, isOver, lastObservedFeeWindow, crowdsourcers }) => ({
        numOutcomes,
        isOver,
        lastObservedFeeWindow,
        crowdsourcers: crowdsourcers
          .map(o => ({ ...o, numerators: o.numerators.toArray() }))
          .toObject()
      }))
      .toObject()
  });
}

export function deserializeState(blob: string): ?State {
  const { version, markets } = JSON.parse(blob);

  if (version !== STATE_VERSION) {
    console.log(
      `Deserialized state of wrong version ${version}, while we know ${STATE_VERSION}, discarding.`
    );
    return null;
  }

  const state = {
    version,
    markets: ImmMap(markets).map(
      ({ numOutcomes, isOver, crowdsourcers, lastObservedFeeWindow }) => ({
        numOutcomes,
        isOver,
        lastObservedFeeWindow,
        crowdsourcers: ImmMap(crowdsourcers).map(o => ({
          ...o,
          numerators: ImmList(o.numerators)
        }))
      })
    )
  };
  invariant(serializeState(state) === blob, "bad serde");
  return state;
}

export async function loadState(path: string): Promise<State> {
  const exists = await fs.pathExists(path);

  if (exists) {
    const string = await fs.readFile(path, "utf8");
    const deserialized = deserializeState(string);

    if (deserialized != null) {
      return deserialized;
    }
  }

  console.log(`Falling back to initial state`);
  return getInitialState();
}

export async function saveState(state: State, path: string): Promise<void> {
  await fs.writeFile(path, serializeState(state), { encoding: "utf8" });
}
