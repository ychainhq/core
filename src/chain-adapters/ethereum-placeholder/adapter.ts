import {
  IChainAdapter,
  BlockchainInfo,
  Block,
  TransactionStatus,
  AddressBalance,
  Utxo,
  FeeEstimate,
  MempoolAcceptResult,
} from '../types';
import { NotImplementedError } from '../../shared/errors/index';

/**
 * Ethereum chain adapter placeholder.
 * This stub implements the IChainAdapter interface but throws NotImplementedError
 * for every method. It exists to ensure the architecture is chain-agnostic
 * and Ethereum support can be added without changing the adapter registry or routing.
 *
 * Ethereum support is planned for a post-beta release.
 */
export class EthereumPlaceholderAdapter implements IChainAdapter {
  public readonly chain = 'ethereum';

  getBlockchainInfo(): Promise<BlockchainInfo> {
    throw new NotImplementedError('Ethereum');
  }

  getBlockCount(): Promise<number> {
    throw new NotImplementedError('Ethereum');
  }

  getBlockHash(_height: number): Promise<string> {
    throw new NotImplementedError('Ethereum');
  }

  getBlock(_hashOrHeight: string | number): Promise<Block> {
    throw new NotImplementedError('Ethereum');
  }

  getRawTransaction(_txHash: string, _verbose?: boolean): Promise<any> {
    throw new NotImplementedError('Ethereum');
  }

  getRawMempool(): Promise<string[]> {
    throw new NotImplementedError('Ethereum');
  }

  getTransactionStatus(_txHash: string): Promise<TransactionStatus> {
    throw new NotImplementedError('Ethereum');
  }

  getAddressBalance(_address: string): Promise<AddressBalance> {
    throw new NotImplementedError('Ethereum');
  }

  getUtxosForAddress(_address: string, _minConfirmations?: number): Promise<Utxo[]> {
    throw new NotImplementedError('Ethereum');
  }

  estimateSmartFee(_targetBlocks: number): Promise<FeeEstimate> {
    throw new NotImplementedError('Ethereum');
  }

  testMempoolAccept(_rawTx: string): Promise<MempoolAcceptResult> {
    throw new NotImplementedError('Ethereum');
  }

  sendRawTransaction(_rawTx: string): Promise<string> {
    throw new NotImplementedError('Ethereum');
  }

  decodeRawTransaction(_rawTx: string): Promise<any> {
    throw new NotImplementedError('Ethereum');
  }

  decodePsbt(_psbt: string): Promise<any> {
    throw new NotImplementedError('Ethereum');
  }

  walletCreateFundedPsbt(_inputs: any[], _outputs: any[], _options?: any): Promise<any> {
    throw new NotImplementedError('Ethereum');
  }

  finalizePsbt(_psbt: string): Promise<any> {
    throw new NotImplementedError('Ethereum');
  }

  isValidAddress(_address: string): boolean {
    throw new NotImplementedError('Ethereum');
  }
}
