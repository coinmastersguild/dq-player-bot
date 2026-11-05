#!/bin/zsh
cd -- "${0:A:h}"
if [[ -x /opt/homebrew/bin/node ]]; then
  exec /opt/homebrew/bin/node bin/console.mjs --open
fi
exec /usr/local/bin/node bin/console.mjs --open
