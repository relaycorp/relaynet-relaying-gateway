import { CargoMessageStream } from '@relaycorp/relaynet-core';
import pino from 'pino';
import uuid from 'uuid-random';

import { ObjectStoreClient, StoreObject } from '../backingServices/objectStorage';

const LOGGER = pino();

export const GATEWAY_BOUND_OBJECT_KEY_PREFIX = 'parcels/gateway-bound';
const INTERNET_BOUND_OBJECT_KEY_PREFIX = 'parcels/internet-bound';
export const EXPIRY_METADATA_KEY = 'parcel-expiry';

export class ParcelStore {
  constructor(protected objectStoreClient: ObjectStoreClient, public bucket: string) {}

  public async *retrieveActiveParcelsForGateway(gatewayAddress: string): CargoMessageStream {
    const prefix = `${GATEWAY_BOUND_OBJECT_KEY_PREFIX}/${gatewayAddress}/`;
    const objectKeys = this.objectStoreClient.listObjectKeys(prefix, this.bucket);
    for await (const parcelObjectKey of objectKeys) {
      // tslint:disable-next-line:no-let
      let parcelObject: StoreObject;
      try {
        parcelObject = await this.objectStoreClient.getObject(parcelObjectKey, this.bucket);
      } catch (error) {
        LOGGER.warn(
          { parcelObjectKey },
          'Parcel object could not be found; it could have been deleted since keys were retrieved',
        );
        continue;
      }

      const parcelExpiryDate = getDateFromTimestamp(parcelObject.metadata[EXPIRY_METADATA_KEY]);
      if (parcelExpiryDate === null) {
        LOGGER.error(
          { parcelObjectKey },
          'Parcel object does not have a valid expiry timestamp metadata',
        );
        continue;
      } else if (parcelExpiryDate <= new Date()) {
        continue;
      }
      yield { expiryDate: parcelExpiryDate, message: parcelObject.body };
    }
  }

  public async retrieveInternetBoundParcel(parcelObjectKey: string): Promise<Buffer> {
    const storeObject = await this.objectStoreClient.getObject(
      makeFullInternetBoundObjectKey(parcelObjectKey),
      this.bucket,
    );
    return storeObject.body;
  }

  public async storeInternetBoundParcel(parcelSerialized: Buffer): Promise<string> {
    const objectKey = uuid();
    await this.objectStoreClient.putObject(
      { body: parcelSerialized, metadata: {} },
      makeFullInternetBoundObjectKey(objectKey),
      this.bucket,
    );
    return objectKey;
  }

  public async deleteInternetBoundParcel(parcelObjectKey: string): Promise<void> {
    await this.objectStoreClient.deleteObject(
      makeFullInternetBoundObjectKey(parcelObjectKey),
      this.bucket,
    );
  }
}

function getDateFromTimestamp(timestampString: string): Date | null {
  if (!timestampString) {
    return null;
  }

  const parcelExpiryTimestamp = parseInt(timestampString, 10);
  const parcelExpiryDate = new Date(parcelExpiryTimestamp * 1_000);
  return Number.isNaN(parcelExpiryDate.getTime()) ? null : parcelExpiryDate;
}

function makeFullInternetBoundObjectKey(parcelObjectKey: string): string {
  return `${INTERNET_BOUND_OBJECT_KEY_PREFIX}/${parcelObjectKey}`;
}

// TODO: Move here
// async function storeParcel(_parcel: Parcel, _parcelSerialized: Buffer): Promise<string> {
//   throw new Error('Not implemented');
// }
