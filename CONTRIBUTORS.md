# Contributors & Attribution

**HashSolo** is an open-source (**GPL-3.0**) fork of [`benjamin-wilson/public-pool`](https://github.com/benjamin-wilson/public-pool). This project stands on the shoulders of the upstream creator, upstream PR/issue authors, and all historical contributors.

## Upstream Creator
- **[@benjamin-wilson](https://github.com/benjamin-wilson)** — Original creator and maintainer of [`benjamin-wilson/public-pool`](https://github.com/benjamin-wilson/public-pool) and [`benjamin-wilson/public-pool-ui`](https://github.com/benjamin-wilson/public-pool-ui).

## Upstream PRs & Issue Credits
Even when fixes or optimizations were re-implemented or adapted for HashSolo's modernized Node.js 26 / NestJS 12 codebase, we want to explicitly credit the original upstream authors whose work inspired or informed those changes:

- **[@mutatrum](https://github.com/mutatrum)**
  - ZMQ `hashblock` subscription ([`benjamin-wilson/public-pool#161`](https://github.com/benjamin-wilson/public-pool/pull/161))
  - Same-height reorg / `isNewPrevHash` block propagation optimization ([`benjamin-wilson/public-pool#162`](https://github.com/benjamin-wilson/public-pool/pull/162))
  - HTTP/HTTPS `keepAlive` agent on `BitcoinRpcService` ([`benjamin-wilson/public-pool#163`](https://github.com/benjamin-wilson/public-pool/pull/163))
- **[@sebrandon1](https://github.com/sebrandon1)**
  - Braiins OS user-agent parsing improvements ([`benjamin-wilson/public-pool#175`](https://github.com/benjamin-wilson/public-pool/pull/175))
- **[@mweinberg](https://github.com/mweinberg)**
  - Share-rate `N/(N-1)` interval bias analysis ([`benjamin-wilson/public-pool#167`](https://github.com/benjamin-wilson/public-pool/issues/167))

## HashSolo Maintainer
- **[@gOOvER](https://github.com/gOOvER)** — HashSolo fork maintainer (Node 26 / NestJS 12 modernization, Stratum V1 TLS, Stratum V2 Noise transport, security hardening, Discord/Telegram/ntfy integrations, and Docker/Dokploy packaging).

## Historical Git Contributors (Upstream `public-pool`)
Thanks to everyone who contributed commits to the upstream git history:
- Aaron Dewes / Seth For Privacy / WantClue / Thomas Shufps / Stijn / Arman The Parman / Dustin Butler / Georges / Jeremy Chabernaud / KillerInk / Luke Childs / Marcel Hernandez / Michael Schmid / Oscar Fawkes / Remco Ros / mr-vcrypto / wario_is_here
