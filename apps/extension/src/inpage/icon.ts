// The Loch mascot (Nessie alone, transparent) as the data: URI a Wallet Standard wallet must carry as its icon.
import mark from "@loch/design/mark/mascot.svg?raw";

export const LOCH_ICON = `data:image/svg+xml;base64,${btoa(mark)}` as const;
