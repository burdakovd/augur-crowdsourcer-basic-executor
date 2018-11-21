// @flow

import * as fs from "fs-extra";
import type { Address } from "./state";

export type Config = {|
  ethereumNode: string,
  feeRecipient: Address,
  executionAccount: string,
  executionPrivateKey: string,
  feeCollectionTriggerAccount: string,
  feeCollectionTriggerPrivateKey: string,
  minGasPrice: number,
  maxGasPrice: number,
  aggressiveness: number,
  mockFeeWindowEnd: ?number,
  offsetForWindowStart: ?number,
|};

async function loadConfig(path: string): Promise<Config> {
  const string = await fs.readFile(path, "utf8");
  return JSON.parse(string);
}

export default loadConfig;
