// @flow

import invariant from "invariant";
import { Map as ImmMap } from "immutable";
import type { State, Address } from "./state";

export function addMarket(
  state: State,
  market: Address,
  { numOutcomes }: {| numOutcomes: number |}
): State {
  invariant(!state.markets.has(market), "already has");
  const newMarkets: ImmMap<
    Address,
    {| numOutcomes: number, isOver: boolean, crowdsourcers: ImmMap<string, *> |}
  > = state.markets.set(market, {
    numOutcomes,
    isOver: false,
    crowdsourcers: ImmMap()
  });
  return {
    ...state,
    markets: newMarkets
  };
}
