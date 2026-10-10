import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";

import { ChannelConnector, CHANNEL_CONNECTORS } from "./connector.interface";
import { PrismaRawOrderSnapshotStore } from "./prisma-raw-order-snapshot.store";
import {
  RAW_ORDER_SNAPSHOT_STORE,
  RawOrderSnapshotStore,
} from "./raw-order-snapshot.port";
import { ShopifyConnector } from "./shopify/shopify.connector";

/**
 * One connector per supported channel platform. Adding a channel means
 * adding its connector here — nothing else in the system changes.
 *
 * Connectors see persistence only through the neutral
 * RAW_ORDER_SNAPSHOT_STORE port; the Prisma-backed store is wired here.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: RAW_ORDER_SNAPSHOT_STORE,
      useFactory: (prisma: PrismaService): RawOrderSnapshotStore =>
        new PrismaRawOrderSnapshotStore(prisma),
      inject: [PrismaService],
    },
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
