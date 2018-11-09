// @flow

import { Set as ImmSet } from "immutable";
import type { State, Address } from "./state";

export function addMarket(state: State, market: Address) {
  const newMarkets: ImmSet<Address> = state.markets.add(market);
  return {
    ...state,
    markets: newMarkets
  };
}
