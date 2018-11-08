// @flow

import fs from "fs-extra";

export type Config = {||};

async function loadConfig(path: string): Promise<Config> {
  const string = await fs.readFile(path);
  return JSON.parse(string);
}

export default loadConfig;
