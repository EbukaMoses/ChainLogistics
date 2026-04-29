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

export type TrackingEventInput = {
    productId: string;
    eventType: string;
    location: string;
    note?: string;
};

/**
 * Submits a tracking event to the ChainLogistics Soroban contract.
 *
 * Builds the `add_tracking_event` invocation, simulates it, signs via
 * Freighter, and submits. Returns the transaction hash on success.
 *
 * Falls back to a simulated response in development when no contract is
 * configured.
 */
export async function addTrackingEvent(
    publicKey: string,
    input: TrackingEventInput
): Promise<string> {
    if (!publicKey || !input.productId) {
        throw new Error("Invalid parameters: publicKey and productId are required");
    }

    // Dev fallback
    if (!CONTRACT_CONFIG.CONTRACT_ID) {
        if (process.env.NODE_ENV === "development") {
            await new Promise((r) => setTimeout(r, 800));
            return "dev_evt_" + Math.random().toString(36).slice(2, 15);
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

    const rpcServer = new rpc.Server(CONTRACT_CONFIG.RPC_URL, { allowHttp: true });
    const contract = new Contract(CONTRACT_CONFIG.CONTRACT_ID);

    try {
        const actorAddress = new Address(publicKey).toScVal();

        // 32-byte zero hash — real implementations would hash the event payload
        const dataHash = xdr.ScVal.scvBytes(Buffer.alloc(32, 0));

        const operation = contract.call(
            "add_tracking_event",
            actorAddress,
            xdr.ScVal.scvString(input.productId),
            xdr.ScVal.scvSymbol(input.eventType),
            xdr.ScVal.scvString(input.location),
            dataHash,
            xdr.ScVal.scvString(input.note ?? ""),
            xdr.ScVal.scvMap([]) // empty metadata map
        );

        const sourceAccount = await rpcServer.getAccount(publicKey);

        const tx = new TransactionBuilder(sourceAccount, {
            fee: "1000000",
            networkPassphrase,
        })
            .addOperation(operation as Parameters<TransactionBuilder["addOperation"]>[0])
            .setTimeout(30)
            .build();

        const simResult = await rpcServer.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(simResult)) {
            throw new Error(`Simulation failed: ${simResult.error}`);
        }

        const assembledTx = rpc.assembleTransaction(tx, simResult).build();
        const signedXdr = await signWithFreighter(assembledTx.toXDR(), networkPassphrase);

        const submitResult = await rpcServer.sendTransaction(
            TransactionBuilder.fromXDR(signedXdr, networkPassphrase)
        );

        if (submitResult.status === "ERROR" || submitResult.status === "TRY_AGAIN_LATER") {
            throw new Error(
                `Transaction submission failed: ${submitResult.status}`
            );
        }

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
            method: "add_tracking_event",
            durationMs: Date.now() - startedAt,
            success: true,
            context: { productId: input.productId, eventType: input.eventType },
        });

        return hash;
    } catch (error) {
        trackContractInteraction({
            method: "add_tracking_event",
            durationMs: Date.now() - startedAt,
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
            context: { productId: input.productId },
        });
        trackError(error, {
            source: "addTrackingEvent",
            productId: input.productId,
        });
        throw error;
    }
}
