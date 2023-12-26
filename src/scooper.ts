import {
  Connection,
  GetProgramAccountsFilter,
  VersionedTransaction,
  sendAndConfirmRawTransaction,
  PublicKey,
  TransactionMessage
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, createCloseAccountInstruction } from '@solana/spl-token';
import { WalletContextState } from '@solana/wallet-adapter-react';
import { Buffer } from 'buffer';
import { SwapResponse, DefaultApi, QuoteResponse } from '@jup-ag/api';

import {
  QuoteGetRequest,
  SwapPostRequest,
  createJupiterApiClient
} from '@jup-ag/api';

interface TokenInfo {
  address: string;
  chainId: number;
  decimals: number;
  name: string;
  symbol: string;
  logoURI: string;
  tags: string[];
  strict?: boolean;
}

interface Asset {
  asset: any;
  swap?: SwapResponse;
  checked?: boolean;
}

interface TokenBalance {
  account: string;
  token: TokenInfo;
  balance: bigint;
}

/**
 * Gets token accounts including standard and token22 accounts
 *
 * Returns a list of all token accounts which match a "known" token in tokenList
 * 
 * @param wallet - The users public key as a string
 * @param connection - The connection to use
 * @param tokenList - List of all known tokens
 * @returns A List of TokenBalances containing information about tokens held by the user and their balances
 */
async function getTokenAccounts(
  wallet: string,
  solanaConnection: Connection,
  tokenList: { [id: string]: TokenInfo }
): Promise<TokenBalance[]> {
  const filters: GetProgramAccountsFilter[] = [
    {
      dataSize: 165
    },
    {
      memcmp: {
        offset: 32,
        bytes: wallet
      }
    }
  ];
  const accountsOld = await solanaConnection.getParsedProgramAccounts(
    TOKEN_PROGRAM_ID,
    { filters: filters }
  );
  const filtersOld: GetProgramAccountsFilter[] = [
    {
      dataSize: 182
    },
    {
      memcmp: {
        offset: 32,
        bytes: wallet
      }
    }
  ];
  const accountsNew = await solanaConnection.getParsedProgramAccounts(
    new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
    { filters: filtersOld }
  );

  const accounts = [...accountsOld, ...accountsNew];

  console.log(
    `Found ${accounts.length} token account(s) for wallet ${wallet}.`
  );
  var tokens: { account: any; token: any; balance: any }[] = [];

  accounts.forEach((account, i) => {
    const parsedAccountInfo: any = account.account.data;
    console.log(parsedAccountInfo);
    const mintAddress: string = parsedAccountInfo['parsed']['info']['mint'];
    const tokenBalance: bigint =
      BigInt(parsedAccountInfo['parsed']['info']['tokenAmount']['amount']);
    if (tokenList[mintAddress]) {
      console.log(
        'Recognised token: ' +
          tokenList[mintAddress].symbol +
          ' have: ' +
          tokenBalance.toString()
      );
      tokens.push({
        account: account,
        token: tokenList[mintAddress],
        balance: tokenBalance.toString()
      });
    }
  });
  return tokens;
}

/**
 * Sweeps a set of assets, signing and executing a set of previously determined transactions to swap them into the target currency
 * 
 * @param wallet - The users public key as a string
 * @param connection - The connection to use
 * @param assets - List of the assets to be swept
 * @param transactionStateCallback - Callback to notify as a transactions state updates
 * @param transactionIdCallback - Callback to notify when a transaction has an ID
 * @param transactionIdCallback - Callback to notify on errors
 * @returns void Promise, promise returns when all actions complete
 */
async function sweepTokens(
  wallet: WalletContextState,
  connection: Connection,
  assets: Asset[],
  transactionStateCallback: (id: string, state: string) => void,
  transactionIdCallback: (id: string, txid: string) => void,
  errorCallback: (id: string, error: any) => void
): Promise<void> {

  const transactions: [string, VersionedTransaction][] = [];
  const blockHash = await (await connection.getLatestBlockhash()).blockhash;

  assets.forEach((asset) => {
    if (asset.checked && wallet.publicKey) {
      if (asset.swap || asset.asset.balance == 0n) {
          const closeAccountIx = createCloseAccountInstruction(
            TOKEN_PROGRAM_ID,
            wallet.publicKey,
            wallet.publicKey,
            [] // multisig
          );
          const message = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockHash,
            instructions: [closeAccountIx],
          }).compileToV0Message();
          const closeAccountTx = new VersionedTransaction(message);
      }
      
      if (asset.swap) {
        // There has to be a better way to do this....
        const swapTransactionBuf = atob(asset.swap.swapTransaction);
        const swapTransactionAr = new Uint8Array(swapTransactionBuf.length);
        for (let i = 0; i < swapTransactionBuf.length; i++) {
          swapTransactionAr[i] = swapTransactionBuf.charCodeAt(i);
        }

        const transaction = VersionedTransaction.deserialize(swapTransactionAr);
        transactions.push([asset.asset.token.address, transaction]);
      }
    }
  });

  if (wallet.signAllTransactions) {
    try {
      const signedTransactions = await wallet.signAllTransactions(
        transactions.map(([id, transaction]) => transaction)
      );

      console.log('Signed transactions:');
      console.log(signedTransactions);
      console.log(transactions);

      await Promise.all(
        signedTransactions.map(async (transaction, i) => {
          const assetId = transactions[i][0];
          transactionStateCallback(assetId, 'Scooping');

          try {
            const result = await sendAndConfirmRawTransaction(
              connection,
              Buffer.from(transaction.serialize()),
              {}
            );
            console.log('Transaction Success!');
            transactionStateCallback(assetId, 'Scooped');
          } catch (err) {
            console.log('Transaction failed!');
            console.log(err);
            transactionStateCallback(assetId, 'Error');
            errorCallback(assetId, err);
          }
        })
      );
    } catch (error) {
      // Handle any error that occurs during signing
      console.error('Error signing transactions:', error);
      errorCallback('', 'Failed signing transactions!');
    }
  }
}

/**
 * Get quotes and transaction data to swap input currencies into output currency
 * 
 * @param connection - The connection to use
 * @param tokens - The tokens to seek quotes for
 * @param outputMint - The Mint for the output currency
 * @param walletAddress - Callback to notify when a transaction has an ID
 * @param quoteApi - Users wallet address
 * @param foundAssetCallback - Callback to notify when an asset held by the user has been found
 * @param foundQuoteCallback - Callback to notify when a quote for the user asset has been found
 * @param foundSwapCallback - Callback to notify when the swap transaction details for the user asset has been found
 * @param errorCallback - Callback to notify on errors
 * @returns void Promise, promise returns when all actions complete
 */
async function findQuotes(
  connection: Connection,
  tokens: { [id: string]: TokenInfo },
  outputMint: string,
  walletAddress: string,
  quoteApi: DefaultApi,
  foundAssetCallback: (id: string, asset: TokenBalance) => void,
  foundQuoteCallback: (id: string, quote: QuoteResponse) => void,
  foundSwapCallback: (id: string, swap: SwapResponse) => void,
  errorCallback: (id: string, err: string) => void
): Promise<void> {
  try {
    const assets = await getTokenAccounts(walletAddress, connection, tokens);

    await Promise.all(
      assets.map(async (asset) => {
        console.log('Found asset');
        console.log(asset);
        foundAssetCallback(asset.token.address, asset);

        const quoteRequest: QuoteGetRequest = {
          inputMint: asset.token.address,
          outputMint: outputMint,
          amount: Number(asset.balance) // Casting this to number can discard precision...
        };

        console.log(quoteRequest);

        try {
          const quote = await quoteApi.quoteGet(quoteRequest);
          foundQuoteCallback(asset.token.address, quote);

          const rq: SwapPostRequest = {
            swapRequest: {
              userPublicKey: walletAddress,
              quoteResponse: quote
            }
          };

          try {
            const swap = await quoteApi.swapPost(rq);
            foundSwapCallback(asset.token.address, swap);
          } catch (swapErr) {
            console.log(`Failed to get swap for ${asset.token.symbol}`);
            console.log(swapErr);
            errorCallback(asset.token.address, "Couldn't get swap transaction");
          }
        } catch (quoteErr) {
          console.log(`Failed to get quote for ${asset.token.symbol}`);
          console.log(quoteErr);
          errorCallback(asset.token.address, "Couldn't get quote");
        }
      })
    );
  } catch (error) {
    console.error('An error occurred:', error);
  }
}

/* Load Jupyter API and tokens */
/**
 * Load Jupyter API and tokens
 * 
 * @returns [instance of Jupiter API, map of known token types by mint address]
 */
async function loadJupyterApi(): Promise<
  [DefaultApi, { [id: string]: TokenInfo }]
> {
  let quoteApi = createJupiterApiClient();
  const allTokens = await fetch('https://token.jup.ag/all');
  const allList = await allTokens.json();
  const tokenMap: { [id: string]: TokenInfo } = {};
  allList.forEach((token: TokenInfo) => {
    tokenMap[token.address] = token;
  });

  const strictTokens = await fetch('https://token.jup.ag/strict');
  const strictList = await strictTokens.json();
  strictList.forEach((token: TokenInfo) => {
    tokenMap[token.address].strict = true;
  });
  return [quoteApi, tokenMap];
}

export { getTokenAccounts, sweepTokens, findQuotes, loadJupyterApi };
export type { TokenInfo, TokenBalance };
