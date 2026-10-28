export const depositQuote = (user: string) => ({
  user,
  useDepositAddress: true,
  strict: true,
  tradeType: "EXACT_INPUT",
});
