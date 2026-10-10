import "@loch/design/all.css";
import "./app.css";

import { SPRITE } from "@loch/design/icons";
import { render } from "preact";

import { extensionApi } from "./api.js";
import { App } from "./App.js";

// The popup is opened as app.html?view=popup; anything else is the expanded view in a tab.
const popup = new URLSearchParams(location.search).get("view") === "popup";
document.documentElement.dataset.view = popup ? "popup" : "wide";

// The icon sprite, inlined once so every <use href="#i-…"> resolves inside this document.
document.body.insertAdjacentHTML("afterbegin", SPRITE);

render(<App api={extensionApi(popup)} />, document.getElementById("app")!);
