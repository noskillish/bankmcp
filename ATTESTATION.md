# Account attestation

**Off by default.** Nothing in this document happens unless you set `ATTESTATION_ENABLED=1`.

Everything else in BankMCP™ answers *you*, through *your* assistant. An attestation answers something much smaller to *someone else*: a service you are proving an account to gets a signed statement that an IBAN is yours — and nothing more.

> "Yes, `NL91ABNA0417164300` is one of my accounts."
> "Yes, it holds at least 500 EUR." *(only if you allow it)*

No balance. No transactions. No list of your accounts. A boolean, a currency, and a signature.

## Why you might want it

Services that need to know an account is really yours normally verify it by sending you a small deposit and asking you to read back the amount, or by asking you to upload a bank statement — a PDF containing every transaction on the account, to prove one line of it.

An attestation replaces that with a yes/no from your own server. The other party learns strictly less than a statement would tell them, and they learn it in a form they can verify cryptographically.

The first use is a payment authorizer proving a funding source belongs to the payer before authorizing payments from it.

## It stays read-only

This does not add payment initiation, and it does not widen your PSD2 consent. The bank calls underneath are the same balance reads `get_balances` already makes. `attest_account` cannot move money, and there is still no tool here that can.

Nothing is sent anywhere on its own: a third party asks, over an authenticated MCP connection you granted, and gets an answer about the one IBAN they named.

## Turning it on

```bash
ATTESTATION_ENABLED=1                 # required; without it the tool is not registered at all
ATTESTATION_MAX_BALANCE=5000          # optional; highest threshold you will answer
ATTESTATION_INCLUDE_HOLDER_NAME=1     # optional; include the name on the account
ATTESTATION_RATE_LIMIT=30             # optional; attestations per hour, 30 by default
```

Restart the server. Two things appear:

- the `attest_account` tool, and
- `GET /.well-known/bankmcp-attestation`, the public key that verifies its signatures.

Unset `ATTESTATION_ENABLED` and both disappear. The tool is not registered rather than registered-and-refusing, so an assistant that lists the tools sees the truth.

### On the thresholds

`ATTESTATION_MAX_BALANCE` is not a formality. Without a ceiling, a caller allowed to ask "at least X?" about any X can binary-search your exact balance in about twenty questions. The ceiling bounds what a series of yes/no answers can reveal.

Leave it unset and no balance question is answered at all — only ownership. That is the most private setting, and it is the default.

### On the rate

The ceiling bounds what one answer reveals. `ATTESTATION_RATE_LIMIT` bounds how many answers a caller gets: thirty an hour, by default, counted across the whole server.

The two are halves of one defence. A ceiling alone still leaves the range below it open to the same search — twenty questions is enough to find a number, and a caller with all the time in the world can ask them. A limit alone would bound the search without bounding what a single answer gives away. Together they make the search cost more than it is worth.

Thirty is far above what the intended use needs. Proving a funding source is a handful of calls when an account is first connected, and a re-proof now and then after that; if you are hitting thirty in an hour, something is asking questions rather than confirming an answer.

Set it to `0` to turn the limiter off. That is a deliberate choice rather than a default, and it gives up the ceiling along with it. Anything the server cannot read as a whole number falls back to thirty, so a typo cannot quietly leave you unbounded.

Refusals count against nothing: a caller that is turned away does not spend a slot, and the message says how long to wait. Signed "no"s do count — an IBAN that is not yours still costs a question, and letting those run free would hand a caller an unmetered way to enumerate.

The count lives in the process, like everything else this server keeps. A restart clears it, which is your action and not a caller's.

### On the holder name

Off by default, because it is personal data and ownership does not need it. Turn it on when the other party must match the name on the account against a company registration.

## The key

Generated on first use with `ATTESTATION_ENABLED=1`, kept at `attestation-key.pem` in your data directory (`~/.bankmcp` locally, `/data` on a server), mode `0600`.

It is deliberately **not** the Enable Banking key. That one authenticates this server *to your bank*; reusing it to sign statements *about* your bank would blur two very different authorities.

Delete the file to rotate. Verifiers refetch the public key within five minutes.

```
GET /.well-known/bankmcp-attestation
```
```json
{
  "version": "bankmcp-attestation-v1",
  "issuer": "https://your-server.example",
  "key_id": "1vn3yG1ATIg66B9Q",
  "algorithm": "ed25519",
  "public_key": "MCowBQYDK2VwAyEA…"
}
```

Public and unauthenticated by design: it only lets someone *check* a signature this server made. A verifier that cannot fetch it cannot verify anything.

## The tool

```
attest_account(iban, nonce, min_balance?)
```

- **`iban`** — the account being asked about. Compared without spaces or case.
- **`nonce`** — the caller's value, copied into the signed claims. It binds the answer to one request, so an old attestation cannot be replayed as a fresh one.
- **`min_balance`** — optional, and only accepted when `ATTESTATION_MAX_BALANCE` is set. Above the ceiling, the tool refuses and says so.

Past `ATTESTATION_RATE_LIMIT` answers in an hour it refuses too, naming the limit and when to come back. The refusal says nothing about the account — a refusal that revealed whether the IBAN was yours would be an answer the caller did not pay for.

Returns, both as text and as structured content against the tool's declared `outputSchema`, so a verifier can confirm the object arrived whole before it checks the signature:

```json
{
  "claims": {
    "v": "bankmcp-attestation-v1",
    "iban": "NL91ABNA0417164300",
    "owned": true,
    "holder_name": null,
    "currency": "EUR",
    "sufficient": true,
    "min_balance": 500,
    "nonce": "2f1c…",
    "issued_at": 1790000000,
    "expires_at": 1790000300,
    "issuer": "https://your-server.example"
  },
  "signature": "…",
  "key_id": "1vn3yG1ATIg66B9Q"
}
```

An IBAN that is not yours gets `owned: false`, signed. A signed "no" is as useful to the caller as a signed "yes", and reveals nothing — they already knew the IBAN they asked about.

Attestations expire after five minutes.

## What a verifier must check

Given `claims`, a verifier rebuilds the signed bytes as `JSON.stringify` over exactly these fields in exactly this order:

```
v, iban, owned, holder_name, currency, sufficient, min_balance,
nonce, issued_at, expires_at, issuer
```

Then, in order: the version is known; the algorithm is `ed25519`; `key_id` matches the key the issuer publishes; the nonce matches the one they sent; the issuer matches where they fetched the key; it has not expired; it was not minted in the future; and the Ed25519 signature verifies.

`verifyAttestation` in `src/attestation.ts` is exported so this is readable as code rather than prose, and `test/attestation.test.ts` walks every field to show that tampering with any of them breaks the signature.

## Turning it off

Unset `ATTESTATION_ENABLED` and restart, or revoke the caller's token by changing your admin password. Either takes effect immediately. Attestations already issued expire within five minutes on their own.
