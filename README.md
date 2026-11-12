<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://app.obibajk.com/brand/obiba-logo-light.png">
  <img src="https://app.obibajk.com/brand/obiba-logo.png" alt="Obiba" width="176">
</picture>

Obiba is a USDC account for Africa, built on NEAR and focused first on Ghana. Customers hold digital dollars in an account they control, fund it from other networks through NEAR Intents, and use it for transfers, remittance, mobile money, airtime and bills.

This repository contains the Obiba backend. The web app is at [app.obibajk.com](https://app.obibajk.com).

```mermaid
flowchart LR
    A["Tron, BNB Chain<br/>Base, Arbitrum, Solana"] --> I["NEAR Intents"]
    I --> O["Obiba account<br/>USDC on NEAR"]
    O --> T["Transfers"]
    O --> R["Remittance"]
    O --> C["Mobile money<br/>and bank cash out"]
    O --> B["Airtime and bills"]
    O --> M["Business checkout"]
    O --> W["Withdrawals"]
    classDef intents fill:#006ee6,stroke:#005bb5,color:#ffffff;
    class I intents;
```

## Capabilities

| Capability | Description |
| --- | --- |
| Deposits | USDC directly on NEAR, or USDT, USDC and SOL from Tron, BNB Chain, Base, Arbitrum and Solana through NEAR Intents |
| Transfers | To any Obiba customer by name or phone number, or to any NEAR account, with network fees sponsored |
| Remittance | To mobile money and bank accounts in Ghana, Kenya and Nigeria, and to bank accounts in South Africa |
| Mobile money | Cash out to MTN, Telecel and AT |
| Bank payouts | Cash out to GCB, Ecobank, Stanbic, Absa and Fidelity |
| Airtime and data | MTN, Telecel and AT |
| Bills | ECG prepaid electricity, Ghana Water, DStv and GOtv |
| Checkout | Pay a business by QR code, payment link or 6-character code. Prices are set in cedis, the rate is locked for 10 minutes, and the customer pays no fee |
| Business accounts | Payment links, QR codes, refunds, daily settlement statements, API keys and signed webhooks |
| Withdrawals | To NEAR accounts, or to USDC on Base and Arbitrum through NEAR Intents |

Mobile money, bank, remittance and bill payments currently run on a pilot rail pending provider integrations. Business checkout settlement is being integrated on NEAR testnet.

## Pay and checkout

A customer can pay a business from their Obiba balance, or from any NEAR wallet without an Obiba account. Before approving, the customer sees the verified business, the order, the price in cedis, the rate, the USDC amount and how long the quote is held.

```mermaid
sequenceDiagram
    participant C as Customer
    participant P as Obiba checkout
    participant A as Obiba API
    participant R as Checkout relay
    participant S as Payment settlement
    participant B as Business account
    C->>P: Scan QR, open link or enter code
    P->>A: Load checkout and quote
    A-->>P: Business, order, rate, USDC total
    C->>P: Approve on device
    P->>A: Signed transfer to relay
    A->>R: Transfer confirmed on NEAR
    R->>S: Pay with signed payment terms
    S->>B: Business share, same transaction
    S-->>A: Signed webhook
    A->>A: Verify payment independently
    A-->>C: Receipt
```

| Step | Guarantee |
| --- | --- |
| Quote | Rate held for 10 minutes. An expired quote must be refreshed and confirmed again |
| Payment terms | Business, payout account, amount, fee and payer are signed and checked on chain |
| Duplicate protection | Each order reference can be paid once, and each signed payment settles once |
| Failure | If settlement is rejected or the quote lapses, the relay returns the funds to the customer |
| Confirmation | A webhook is never trusted alone. The API confirms the payment before marking it paid |

Customers paying from another NEAR wallet approve one transfer in their wallet, and it settles through the same contract.

## Businesses

Any Obiba customer can open a business account. Payments settle to the business's own Obiba account in the same transaction the customer pays, with no payout delay.

```mermaid
flowchart LR
    S["Sign up on Obiba"] --> E["Enable business payments<br/>verified business profile"]
    E --> B["Business payout setup<br/>payout account = Obiba account"]
    B --> L["Payment link, QR or code"]
    B --> X["Checkout from the<br/>business's own server"]
    L --> P["Customer pays<br/>Obiba balance or NEAR wallet"]
    X --> P
    P --> T["Settled to the business<br/>in the same transaction"]
    T --> D["Payments, refunds<br/>and daily statements"]
    T --> H["Signed webhook<br/>to the business"]
    classDef settle fill:#006ee6,stroke:#005bb5,color:#ffffff;
    class B,T settle;
```

| Feature | Description |
| --- | --- |
| Payment links | Fixed amount in cedis, order reference, expiry, branded QR code and 6-character code |
| Payments | Searchable history with status, rate, fee and settlement for every payment |
| Refunds | Full or partial, returned to the customer's balance or wallet and shown on their receipt |
| Settlements | Daily totals of gross, fees, refunds and net, with CSV export |
| Developers | Publishable and secret API keys, checkout sessions from the business's server, signed webhooks |

| Fees | |
| --- | --- |
| Customer | None |
| Business | 1% of each payment, deducted at settlement. Not returned on refunds |

## NEAR Intents

Cross-chain deposits and withdrawals use NEAR Intents through the 1Click API. Obiba verifies each step independently, and a customer's balance changes only when the transfer is confirmed on NEAR. 1Click operates on NEAR mainnet; the hosted app currently runs on NEAR testnet.

```mermaid
sequenceDiagram
    participant C as Customer
    participant A as Obiba API
    participant I as NEAR Intents
    participant N as NEAR
    participant L as Ledger
    C->>A: Start deposit
    A->>I: Request quote
    I-->>A: Signed quote
    A->>A: Verify signature and quoted terms
    A-->>C: Deposit address
    C->>I: Transfer on origin chain
    I->>N: Deliver USDC to customer account
    N-->>L: Finalized transfer indexed
    L-->>C: Balance credited
```

| Stage | Verification |
| --- | --- |
| Quote | The quote signature is checked, and every signed field must match the request |
| Deposit | Credited only when the indexer reads a matching transfer on NEAR |
| Withdrawal | Completed only after the transfer is verified on the destination chain, with 10 confirmations |
| Exceptions | Short deliveries and unmatched transfers are held for review |

## Architecture

```mermaid
flowchart TB
    App["Web app"] --> API["API"]
    API --> DB[("PostgreSQL<br/>ledger and outbox")]
    API --> G["Guardian"]
    DB --> W["Worker"]
    W --> N["NEAR<br/>obiba-account, obiba-pay"]
    W <--> I["NEAR Intents"]
    W --> S["Payment settlement"]
    S -.-> API
    G -.-> N
    N --> X["Indexer"]
    X --> DB
    classDef intents fill:#006ee6,stroke:#005bb5,color:#ffffff;
    class I,S intents;
```

| Service | Responsibility |
| --- | --- |
| `api` | GraphQL API, restricted to allow-listed operations. Prepares payments for signing on the customer's device, serves checkout sessions to businesses and receives settlement webhooks |
| `worker` | Relays signed transactions, provisions accounts, tracks deposits and withdrawals, runs the checkout relay, sends customer email |
| `indexer` | Streams finalized NEAR blocks into the double-entry ledger |
| `guardian` | Independent service that co-signs payments above the account limit |
| `admin`, `ops` | Staff API and operations console |

## NEAR integration

| Feature | Use in Obiba |
| --- | --- |
| NEAR Intents | Cross-chain deposits and withdrawals |
| Global contracts | One `obiba-account` deployment shared by every customer, at about 0.009 NEAR per new account |
| Delegate actions | Customers sign payments, and Obiba pays the network fees |
| Function-call keys | Device keys can only call the customer's own account |
| Named accounts | Readable account names under the Obiba namespace |

## Security model

- Customers authorize payments with a non-extractable key held on their device.
- Spending limits are enforced by the account contract. Payments above the limit require a guardian co-signature, and the guardian cannot move funds alone.
- Account recovery uses SMS and email verification, followed by a 48-hour on-chain delay that an existing device can cancel.
- A reconciler compares the ledger with NEAR and pauses outgoing payments on any account that does not match.
- Business events and their follow-up jobs commit in a single database transaction.
- Each service uses its own database role, with row-level security on customer data.
- Sensitive staff actions require approval from a second person.

<details>
<summary>Repository structure</summary>

| Path | Contents |
| --- | --- |
| `apps/api` | NestJS and GraphQL API |
| `apps/worker` | Background jobs, relayer and email |
| `apps/indexer` | Block stream and ledger settlement |
| `apps/guardian` | Co-signing service |
| `apps/admin`, `apps/ops` | Staff API and console |
| `packages/domain` | Encodings, state machines and shared types |
| `packages/db` | Migrations and ledger |
| `packages/near` | RPC, signing and event extraction |
| `packages/intents` | 1Click client and quote verification |

</details>

<details>
<summary>Build</summary>

Requires Node 22 and pnpm 10.

```bash
pnpm install
pnpm build
```

</details>
