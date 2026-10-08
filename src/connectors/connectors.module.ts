import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";

import { ChannelConnector, CHANNEL_CONNECTORS } from "./connector.interface";
import { ShopifyConnector } from "./shopify/shopify.connector";

/**
 * One connector per supported channel platform. Adding a channel means
 * adding its connector here — nothing else in the system changes.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    ShopifyConnector,
    {
      provide: CHANNEL_CONNECTORS,
      useFactory: (shopify: ShopifyConnector): ChannelConnector[] => [
        shopify,
      ],
      inject: [ShopifyConnector],
    },
  ],
  exports: [ShopifyConnector, CHANNEL_CONNECTORS],
})
export class ConnectorsModule {}
