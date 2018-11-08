// @flow

import main from "./main";

if (!global._babelPolyfill) {
  require("babel-polyfill");
}

main();
