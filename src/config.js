// @flow

import * as fs from "fs-extra";

export type Config = {|
  augurNode: string,
  ethereumNode: string
|};

async function loadConfig(path: string): Promise<Config> {
  const string = await fs.readFile(path, "utf8");
  return JSON.parse(string);
}

export default loadConfig;
