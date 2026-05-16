# MobAir

MobAir é o app Android de carteira do ecossistema OffAir. Ele mantém a mesma arquitetura de produto que estava sendo desenvolvida com o nome AirPay, mas move a marca pública para longe de um nome que já existe como token na Solana.

Versão em inglês: [README.md](./README.md)

## O Que o MobAir Faz

- Cria e importa carteiras Solana em autocustódia.
- Assina pagamentos Solana online localmente.
- Lê links e QR Codes de pagamento do Gateway.
- Mantém pagamentos Gateway online-diferidos em fila quando o aparelho está temporariamente offline.
- Suporta fluxos OffAir de promessa offline local entre dispositivos próximos.
- Mantém risco local, confiança, score, cache de blocklist e estado de sincronização.
- Usa Bluetooth, NFC e execução em background local quando disponível no Android.

## Notas de Compatibilidade

O nome visível do app é MobAir. Alguns identificadores técnicos continuam iguais de propósito para preservar compatibilidade do MVP:

- O package id Android continua `com.airpay.wallet`.
- Links de pagamento ainda podem usar o esquema legado `airpay://pay`.
- Payloads de protocolo ainda podem conter domínios legados `airpay:*`.

Esses identificadores são superfícies de compatibilidade técnica, não afirmações públicas de marca.

## Escopo do Repositório

Este repositório contém apenas o app mobile. Gateway, site, Support, SDKs, contratos inteligentes, docs e infraestrutura ficam em repositórios separados na organização `protocol-offair`.

## Desenvolvimento

```bash
npm install
npm run typecheck
npm run android
```

Execuções por tema:

```bash
npm run android:light
npm run android:dark
```

## Testes

```bash
npm run typecheck
npm run test:offline-sim
npm run smoke:devnet
```

Testes físicos online, híbridos e offline devem usar os scripts ADB dedicados do repositório `offair-infra`.

## Limites

MobAir não é banco, exchange, carteira fiat nem provedor custodial de saldo. Ele é uma interface de autocustódia para pagamentos Solana e fluxos OffAir de promessas offline com risco limitado.
