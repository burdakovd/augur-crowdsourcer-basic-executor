// @flow

import invariant from "invariant";
import { Map as ImmMap } from "immutable";
import type { State, Address } from "./state";

export function addMarket(
  state: State,
  market: Address,
  { numOutcomes, feeWindow }: {| numOutcomes: number, feeWindow: number |}
): State {
  invariant(!state.markets.has(market), "already has");
  const newMarkets: ImmMap<
    Address,
    {|
      numOutcomes: number,
      isOver: boolean,
      lastObservedFeeWindow: number,
      crowdsourcers: ImmMap<string, *>
    |}
  > = state.markets.set(market, {
    numOutcomes,
    lastObservedFeeWindow: feeWindow,
    isOver: false,
    crowdsourcers: ImmMap()
  });
  return {
    ...state,
    markets: newMarkets
  };
}
