// @flow

import { getInitialState, serializeState, deserializeState } from "./state";

it("can get initial state", () => {
  expect(getInitialState()).toBeTruthy();
});

it("can serialize and deserialize", () => {
  const state = getInitialState();
  const s1 = serializeState(state);
  const s2 = serializeState(deserializeState(s1));
  expect(s2).toBe(s1);
});
