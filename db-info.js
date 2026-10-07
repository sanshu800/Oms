require("dotenv").config();

const { PrismaClient } = require("@prisma/client");

const p = new PrismaClient();

p.$queryRawUnsafe(`
  SELECT current_database(), current_schema(), inet_server_addr(), inet_server_port()
`)
.then(function (x) {
  console.log(x);
})
.catch(function (e) {
  console.error(e);
})
.finally(function () {
  return p.$disconnect();
});
