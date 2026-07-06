# Ycha.in + Hyperledger Besu: scenariusze node'ow

Dokument podsumowuje role node'ow i komponentow dla czterech scenariuszy:

1. Besu QBFT bez produkcji blokow
2. Besu QBFT z produkcja blokow
3. Public Ethereum bez produkcji blokow
4. Public Ethereum z produkcja blokow

Legenda:

- **TAK** = potrzebne
- **NIE** = niepotrzebne
- **OPC.** = opcjonalne / zalezne od architektury
- **ZEW.** = moze byc zewnetrzny provider, niekoniecznie Twoj node

---

## 1. Tabela glowna: typy node'ow / komponentow vs scenariusze

| Typ node'a / komponent | Besu QBFT bez produkcji blokow | Besu QBFT z produkcja blokow | Public Ethereum bez produkcji blokow | Public Ethereum z produkcja blokow |
|---|---:|---:|---:|---:|
| **Besu validator node** | NIE | **TAK** | NIE | NIE |
| **Besu non-validator RPC node** | **TAK** | **TAK** | **TAK / ZEW.** | **TAK** |
| **Besu indexer / read node** | **TAK** | **TAK** | **TAK / ZEW.** | **TAK** |
| **Besu archive node** | OPC. | OPC. | OPC. | OPC. |
| **Besu bootnode** | OPC. | OPC. | NIE | NIE |
| **Ethereum consensus client** | NIE | NIE | OPC. | **TAK** |
| **Ethereum validator client PoS** | NIE | NIE | NIE | **TAK** |
| **Ycha.in signer / external signer** | **TAK** | **TAK** | **TAK** | **TAK** |
| **Ycha.in nonce manager** | **TAK** | **TAK** | **TAK** | **TAK** |
| **Ycha.in indexer worker** | **TAK** | **TAK** | **TAK** | **TAK** |
| **Ycha.in DB / ledger / cursor store** | **TAK** | **TAK** | **TAK** | **TAK** |

---

## 2. Jak czytac scenariusze

| Scenariusz | Znaczenie |
|---|---|
| **Besu QBFT bez produkcji blokow** | Klient uzywa istniejacej prywatnej sieci Besu, ale sam nie jest walidatorem. Potrzebuje tylko RPC/indexera do wysylania i indeksowania transakcji. |
| **Besu QBFT z produkcja blokow** | Klient uczestniczy w prywatnej sieci jako walidator albo sam stawia prywatna siec. Potrzebuje Besu validator node'ow. |
| **Public Ethereum bez produkcji blokow** | Klient obsluguje ETH/ERC-20 na publicznym Ethereum, ale nie waliduje. Moze uzywac wlasnego Besu RPC/indexera albo zewnetrznego RPC providera. |
| **Public Ethereum z produkcja blokow** | Klient chce byc walidatorem Ethereum PoS. Besu jest tylko execution clientem, wiec potrzebuje jeszcze consensus clienta i validator clienta. |

---

## 3. Minimalne setupy per scenariusz

| Scenariusz | Minimalny sensowny setup |
|---|---|
| **Besu QBFT bez produkcji blokow** | `1x Besu RPC`, `1x Besu indexer/read`, `signer`, `nonce manager`, `DB`, `Ycha.in worker` |
| **Besu QBFT z produkcja blokow** | `4x Besu validator QBFT`, `1x Besu RPC`, `1x Besu indexer`, `signer`, `nonce manager`, `DB`, `Ycha.in worker` |
| **Public Ethereum bez produkcji blokow** | `1x Besu RPC/indexer` albo zewnetrzny RPC provider, `signer`, `nonce manager`, `DB`, `Ycha.in worker` |
| **Public Ethereum z produkcja blokow** | `1x Besu execution`, `1x consensus client`, `1x validator client`, `RPC/indexer`, `signer`, `nonce manager`, `DB`, `Ycha.in worker` |

---

## Najwazniejsza konkluzja

**Validator w Besu QBFT** i **validator w publicznym Ethereum PoS** to nie jest ta sama rola techniczna.

W prywatnej sieci **Besu QBFT** validator to po prostu odpowiednio skonfigurowany **Besu node**, ktory bierze udzial w konsensusie QBFT, proponuje bloki, podpisuje/gŇāosuje nad blokami i wspolnie z innymi validatorami finalizuje chain.

W publicznym **Ethereum PoS** Besu jest tylko **execution clientem**. Do faktycznego walidowania i produkcji blokow potrzebny jest dodatkowo **consensus client** oraz **validator client PoS** z odpowiednimi validator keys i stake.

---

## Skrocona wersja

```text
Besu QBFT bez blokow:
RPC/indexer wystarczy.

Besu QBFT z blokami:
potrzebujesz Besu validator node'ow.

Public Ethereum bez blokow:
Besu jako RPC/indexer wystarczy do obslugi transakcji.

Public Ethereum z blokami:
Besu + consensus client + validator client + stake/validator keys.
```
