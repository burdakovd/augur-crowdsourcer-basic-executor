// @flow

import * as fs from "fs-extra";
import type { Address } from "./state";

export type Config = {|
  augurNode: string,
  ethereumNode: string,
  feeRecipient: Address,
  executionPrivateKey: string
|};

async function loadConfig(path: string): Promise<Config> {
  const string = await fs.readFile(path, "utf8");
  return JSON.parse(string);
}

export default loadConfig;
