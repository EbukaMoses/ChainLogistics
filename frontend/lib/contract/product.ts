import {
    Address,
    Contract,
    Networks,
    TransactionBuilder,
    xdr,
    rpc,
} from "@stellar/stellar-sdk";
import { signWithFreighter } from "@/lib/stellar/wallet";
import { CONTRACT_CONFIG, validateContractConfig } from "./config";
import { trackContractInteraction, trackError } from "@/lib/analytics";

export type ProductData = {
    id: string;
    name: string;
    origin: string;
    description?: string;
    category: string;
};

/**
 * Registers a product on the Stellar/Soroban blockchain.
 *
 * Builds a Soroban contract invocation transaction, simulates it to get the
 * authorisation footprint, then asks Freighter to sign and submits it.
 *
 * When no CONTRACT_ID is configured (local dev) it falls back to a simulated
 * response so the UI remains usable without a live contract.
 */
export async function registerProductOnChain(
    publicKey: string,
    data: ProductData
): Promise<string> {
    if (!publicKey || !data.id) {
        throw new Error("Invalid contract parameters");
    }

    // Dev fallback — no contract configured
    if (!CONTRACT_CONFIG.CONTRACT_ID) {
        if (process.env.NODE_ENV === "development") {
            await new Promise((r) => setTimeout(r, 800));
            return "dev_" + Math.random().toString(36).slice(2, 15);
        }
        throw new Error(
            "Contract not configured. Set NEXT_PUBLIC_CONTRACT_ID in your environment."
        );
    }

    validateContractConfig();

    const startedAt = Date.now();
    const networkPassphrase =
        CONTRACT_CONFIG.NETWORK === "mainnet"
            ? Networks.PUBLIC
            : CONTRACT_CONFIG.NETWORK === "futurenet"
                ? Networks.FUTURENET
                : Networks.TESTNET;

    const rpcServer = new rpc.Server(CONTRACT_CONFIG.RPC_URL, {
        allowHttp: true,
    });
    const contract = new Contract(CONTRACT_CONFIG.CONTRACT_ID);

    try {
        // Build the ScVal arguments matching the on-chain ProductConfig struct
        const emptyVec = xdr.ScVal.scvVec([]);
        const emptyMap = xdr.ScVal.scvMap([]);

        const productConfigVal = xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol("id"),
                val: xdr.ScVal.scvString(data.id),
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol("name"),
                val: xdr.ScVal.scvString(data.name),
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol("description"),
                val: xdr.ScVal.scvString(data.description ?? ""),
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol("origin_location"),
                val: xdr.ScVal.scvString(data.origin),
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol("category"),
                val: xdr.ScVal.scvString(data.category),
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol("tags"),
                val: emptyVec,
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol("certifications"),
                val: emptyVec,
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol("media_hashes"),
                val: emptyVec,
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol("custom"),
                val: emptyMap,
            }),
        ]);

        const ownerAddress = new Address(publicKey).toScVal();
        const operation = contract.call(
            "register_product",
            ownerAddress,
            productConfigVal
        );

        // Fetch the caller's account for sequence number
        const sourceAccount = await rpcServer.getAccount(publicKey);

        const tx = new TransactionBuilder(sourceAccount, {
            fee: "1000000", // 0.1 XLM max fee
            networkPassphrase,
        })
            .addOperation(operation as Parameters<TransactionBuilder["addOperation"]>[0])
            .setTimeout(30)
            .build();

        // Simulate to get the auth footprint and resource fees
        const simResult = await rpcServer.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(simResult)) {
            throw new Error(`Simulation failed: ${simResult.error}`);
        }

        // Assemble the transaction with the simulation result (sets soroban data + fees)
        const assembledTx = rpc.assembleTransaction(tx, simResult).build();

        // Ask Freighter to sign
        const signedXdr = await signWithFreighter(
            assembledTx.toXDR(),
            networkPassphrase
        );

        // Submit
        const submitResult = await rpcServer.sendTransaction(
            TransactionBuilder.fromXDR(signedXdr, networkPassphrase)
        );

        if (
            submitResult.status === "ERROR" ||
            submitResult.status === "TRY_AGAIN_LATER"
        ) {
            throw new Error(
                `Transaction submission failed: ${submitResult.status}`
            );
        }

        // Poll for confirmation
        const hash = submitResult.hash;
        let getResult = await rpcServer.getTransaction(hash);
        let attempts = 0;
        while (
            getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND &&
            attempts < 20
        ) {
            await new Promise((r) => setTimeout(r, 1500));
            getResult = await rpcServer.getTransaction(hash);
            attempts++;
        }

        if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
            throw new Error("Transaction was included in a ledger but failed.");
        }

        trackContractInteraction({
            method: "register_product",
            durationMs: Date.now() - startedAt,
            success: true,
            context: { productId: data.id },
        });

        return hash;
    } catch (error) {
        trackContractInteraction({
            method: "register_product",
            durationMs: Date.now() - startedAt,
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
            context: { productId: data.id },
        });
        trackError(error, { source: "registerProductOnChain", productId: data.id });
        throw error;
    }
}
