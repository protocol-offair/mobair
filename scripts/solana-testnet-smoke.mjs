import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const airdropLamports = Number(process.env.AIRPAY_DEVNET_AIRDROP_LAMPORTS ?? Math.floor(0.05 * LAMPORTS_PER_SOL));
const transferLamports = Number(process.env.AIRPAY_DEVNET_TRANSFER_LAMPORTS ?? 1_000_000);

const connection = new Connection(rpcUrl, "confirmed");

function loadSenderKeypair() {
  const secretKeyJson = process.env.AIRPAY_DEVNET_SENDER_SECRET_KEY_JSON;
  if (!secretKeyJson) {
    return Keypair.generate();
  }

  const parsed = JSON.parse(secretKeyJson);
  if (!Array.isArray(parsed)) {
    throw new Error("AIRPAY_DEVNET_SENDER_SECRET_KEY_JSON must be a JSON array of secret key bytes.");
  }

  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

const sender = loadSenderKeypair();
const recipient = process.env.AIRPAY_DEVNET_RECIPIENT_ADDRESS
  ? new PublicKey(process.env.AIRPAY_DEVNET_RECIPIENT_ADDRESS)
  : Keypair.generate().publicKey;

async function main() {
  const version = await connection.getVersion();
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");

  let airdropSignature = null;
  if (!process.env.AIRPAY_DEVNET_SENDER_SECRET_KEY_JSON) {
    airdropSignature = await connection.requestAirdrop(sender.publicKey, airdropLamports);
    await connection.confirmTransaction(airdropSignature, "confirmed");
  }

  const balanceBefore = await connection.getBalance(sender.publicKey, "confirmed");
  if (balanceBefore < transferLamports) {
    throw new Error(`Airdrop confirmed without enough balance. before=${balanceBefore} transfer=${transferLamports}`);
  }

  const transaction = new Transaction({
    feePayer: sender.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
  }).add(
    SystemProgram.transfer({
      fromPubkey: sender.publicKey,
      toPubkey: recipient,
      lamports: transferLamports,
    }),
  );

  const transferSignature = await sendAndConfirmTransaction(connection, transaction, [sender], {
    commitment: "confirmed",
  });

  const [senderBalanceAfter, recipientBalanceAfter] = await Promise.all([
    connection.getBalance(sender.publicKey, "confirmed"),
    connection.getBalance(recipient, "confirmed"),
  ]);

  console.log(
    JSON.stringify(
      {
        cluster: "solana-devnet",
        rpcUrl,
        solanaCore: version["solana-core"],
        featureSet: version["feature-set"],
        airdropLamports,
        transferLamports,
        sender: sender.publicKey.toBase58(),
        recipient: recipient.toBase58(),
        airdropSignature,
        transferSignature,
        senderBalanceAfter,
        recipientBalanceAfter,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        cluster: "solana-devnet",
        rpcUrl,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
