// @flow

import nullthrows from "nullthrows";
import { getInitialState, serializeState, deserializeState } from "./state";

it("can get initial state", () => {
  expect(getInitialState()).toBeTruthy();
});

it("can serialize and deserialize", () => {
  const state = getInitialState();
  const s1 = serializeState(state);
  const s2 = serializeState(nullthrows(deserializeState(s1)));
  expect(s2).toBe(s1);
});
