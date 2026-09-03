const pollMinutes = 5;
const DEFAULT_POLL_MINUTES = 1;
const start = new Date(Date.now() + 2 * 60 * 1000); // 2 mins from now
const now = new Date();
const msUntil = start - now;
console.log("msUntil:", msUntil);
console.log("condition:", msUntil <= (pollMinutes || DEFAULT_POLL_MINUTES) * 60 * 1000 && msUntil >= -60 * 1000);
