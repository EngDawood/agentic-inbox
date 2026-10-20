/**
 * Sender blocklist.
 *
 * One global list in R2, applied to every mailbox and every recipient alias.
 * That is deliberate: signing up to one site with several aliases should need
 * a single block, not one per alias. Matching is on the exact sender address.
 */

const BLOCKLIST_KEY = "blocklist.json";

export interface BlockedSender {
	address: string;
	addedAt: string;
}

export function normalizeAddress(address: string): string {
	return address.trim().toLowerCase();
}

export async function getBlocklist(bucket: R2Bucket): Promise<BlockedSender[]> {
	const obj = await bucket.get(BLOCKLIST_KEY);
	if (!obj) return [];
	try {
		const list = await obj.json<BlockedSender[]>();
		return Array.isArray(list) ? list : [];
	} catch {
		return [];
	}
}

export async function isBlocked(bucket: R2Bucket, sender: string): Promise<boolean> {
	const address = normalizeAddress(sender);
	if (!address) return false;
	return (await getBlocklist(bucket)).some((b) => b.address === address);
}

/** Returns false when the address was already blocked. */
export async function blockSender(bucket: R2Bucket, sender: string): Promise<boolean> {
	const address = normalizeAddress(sender);
	const list = await getBlocklist(bucket);
	if (list.some((b) => b.address === address)) return false;
	list.push({ address, addedAt: new Date().toISOString() });
	await bucket.put(BLOCKLIST_KEY, JSON.stringify(list));
	return true;
}

/** Returns false when the address was not blocked. */
export async function unblockSender(bucket: R2Bucket, sender: string): Promise<boolean> {
	const address = normalizeAddress(sender);
	const list = await getBlocklist(bucket);
	const next = list.filter((b) => b.address !== address);
	if (next.length === list.length) return false;
	await bucket.put(BLOCKLIST_KEY, JSON.stringify(next));
	return true;
}
