// @flow

import { Map as ImmMap } from "immutable";
import type { State, Address } from "./state";

export function addMarket(
  state: State,
  market: Address,
  { numOutcomes }: {| numOutcomes: number |}
) {
  const newMarkets: ImmMap<
    Address,
    {| numOutcomes: number |}
  > = state.markets.set(market, { numOutcomes });
  return {
    ...state,
    markets: newMarkets
  };
}
