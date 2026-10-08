require("dotenv").config();

const { PrismaClient } = require("@prisma/client");

const p = new PrismaClient();

p.storeConnection.findUnique({
  where: {
    platform_externalStoreId: { platform: "SHOPIFY", externalStoreId: "test.myshopify.com" }
  }
})
.then(function (x) {
  console.log(x);
})
.catch(function (e) {
  console.error(e);
})
.finally(function () {
  return p.$disconnect();
});
