import { useRelayConfig, useTokenPrice } from "@relayprotocol/relay-kit-hooks";

export async function usdPrice(chainId: number, address: string) {
  const r = await fetch(`https://api.relay.link/currencies/token/price?chainId=${chainId}&address=${address}`);
  return (await r.json()).price;
}

export function useLimits() {
  const { data } = useRelayConfig({ originChainId: 8453, destinationChainId: 42161 });
  const price = useTokenPrice({ chainId: 8453, address: "0x0" });
  return { max: data?.solver?.capacityPerRequest, total: price.data?.price + 1 };
}
