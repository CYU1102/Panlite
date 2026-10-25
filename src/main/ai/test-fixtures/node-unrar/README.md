# Official node-unrar-js RAR fixtures

Source: https://github.com/YuJianrong/node-unrar.js

Pinned commit: `8c615868c9e2ec5ef2e661c5bcaee20ffad3862c`.

The maintainer's repository is the upstream repository declared by the installed
`node-unrar-js` package. The repository uses the MIT license; its complete
copyright and permission notice is preserved in `LICENSE.md` alongside these
unmodified test fixtures. No UnRAR implementation source is copied here.

| File | Original path | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| FolderTest.rar | testFiles/FolderTest.rar | 5618 | aa9c77fd07e992cf3ef2f464382353841747532cfa03726bfcde0ff3884013ff |
| HeaderEnc1234.rar | testFiles/HeaderEnc1234.rar | 356 | e481752a64e68afc6d5d67710493faf1a36cc1fb2e24eb286ba1d790013ef45c |

Download URLs:

- https://raw.githubusercontent.com/YuJianrong/node-unrar.js/8c615868c9e2ec5ef2e661c5bcaee20ffad3862c/testFiles/FolderTest.rar
- https://raw.githubusercontent.com/YuJianrong/node-unrar.js/8c615868c9e2ec5ef2e661c5bcaee20ffad3862c/testFiles/HeaderEnc1234.rar

Expected names, sizes, Unicode text, and the long-text generation rule were
checked against upstream `src/test/ExtractorData.spec.ts` at the same commit.
The header-encrypted fixture uses the upstream documented test password `1234`.
These fixtures contain synthetic test content and require no cloud credentials.
Tests run entirely offline after checkout.
