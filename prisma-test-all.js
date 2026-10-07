require("dotenv").config();

const { PrismaClient } = require("@prisma/client");

const p = new PrismaClient();

p.storeConnection.findMany()
  .then(function (rows) {
    console.log(JSON.stringify(rows, null, 2));
  })
  .catch(function (e) {
    console.error(e);
  })
  .finally(function () {
    return p.$disconnect();
  });
