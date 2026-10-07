console.log("BEFORE dotenv:");
console.log(process.env.DATABASE_URL);

require("dotenv").config();

console.log("AFTER dotenv:");
console.log(process.env.DATABASE_URL);
