import * as pohttp from '@relaycorp/relaynet-pohttp';
import { EnvVarError } from 'env-var';
import { Message } from 'node-nats-streaming';

import {
  arrayToAsyncIterable,
  makeMockLogging,
  MockLogging,
  mockSpy,
  partialPinoLog,
} from '../_test_utils';
import { NatsStreamingClient } from '../backingServices/natsStreaming';
import * as objectStorage from '../backingServices/objectStorage';
import { ParcelStore, QueuedInternetBoundParcelMessage } from '../parcelStore';
import {
  configureMockEnvVars,
  getMockInstance,
  mockStanMessage,
  TOMORROW,
} from '../services/_test_utils';
import * as exitHandling from '../utilities/exitHandling';
import * as logging from '../utilities/logging';
import { processInternetBoundParcels } from './pdcOutgoing';

const OWN_POHTTP_ADDRESS = 'https://gateway.endpoint/';

const WORKER_NAME = 'the-worker';

const MOCK_NATS_CLIENT = {
  makeQueueConsumer: mockSpy(jest.fn()),
  publishMessage: mockSpy(jest.fn()),
};
const MOCK_NATS_CLIENT_INIT = mockSpy(
  jest.spyOn(NatsStreamingClient, 'initFromEnv'),
  () => MOCK_NATS_CLIENT,
);

const ENV_VARS = {
  OBJECT_STORE_BUCKET: 'the-bucket',
};
const mockEnvVars = configureMockEnvVars(ENV_VARS);

jest.mock('@relaycorp/relaynet-pohttp', () => {
  const actualPohttp = jest.requireActual('@relaycorp/relaynet-pohttp');
  return {
    ...actualPohttp,
    deliverParcel: jest.fn(),
  };
});
beforeEach(() => {
  getMockInstance(pohttp.deliverParcel).mockRestore();
});

const QUEUE_MESSAGE_DATA: QueuedInternetBoundParcelMessage = {
  deliveryAttempts: 0,
  parcelExpiryDate: TOMORROW,
  parcelObjectKey: 'foo.parcel',
  parcelRecipientAddress: 'https://endpoint.example/',
};
const QUEUE_MESSAGE_DATA_SERIALIZED = Buffer.from(JSON.stringify(QUEUE_MESSAGE_DATA));

const PARCEL_SERIALIZED = Buffer.from('Pretend this is a RAMF-serialized parcel');

mockSpy(jest.spyOn(objectStorage, 'initObjectStoreFromEnv'), () => undefined);

const MOCK_RETRIEVE_INTERNET_PARCEL = mockSpy(
  jest.spyOn(ParcelStore.prototype, 'retrieveEndpointBoundParcel'),
  async () => PARCEL_SERIALIZED,
);
const MOCK_DELETE_INTERNET_PARCEL = mockSpy(
  jest.spyOn(ParcelStore.prototype, 'deleteEndpointBoundParcel'),
  async () => undefined,
);

let mockLogging: MockLogging;
beforeEach(() => {
  mockLogging = makeMockLogging();
});
const mockMakeLogger = mockSpy(jest.spyOn(logging, 'makeLogger'), () => mockLogging.logger);

const mockExitHandler = mockSpy(jest.spyOn(exitHandling, 'configureExitHandling'));

describe('processInternetBoundParcels', () => {
  test('Logger should be configured', async () => {
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([]));

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expect(mockMakeLogger).toBeCalledWith();
  });

  test('Exit handler should be configured as the very first step', async () => {
    mockEnvVars({});

    await expect(processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS)).toReject();

    expect(mockExitHandler).toBeCalledWith(
      expect.toSatisfy((logger) => logger.bindings().worker === WORKER_NAME),
    );
  });

  test('Start of the queue should be logged', async () => {
    mockEnvVars({});

    await expect(processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS)).toReject();

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Starting queue worker', { worker: WORKER_NAME }),
    );
  });

  test.each(Object.keys(ENV_VARS))('Environment variable %s should be present', async (envVar) => {
    mockEnvVars({ ...ENV_VARS, [envVar]: undefined });

    await expect(
      processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS),
    ).rejects.toBeInstanceOf(EnvVarError);
  });

  test('Expired parcels should be skipped and deleted from store', async () => {
    const aSecondAgo = new Date();
    aSecondAgo.setSeconds(aSecondAgo.getSeconds() - 1);
    const messageData: QueuedInternetBoundParcelMessage = {
      deliveryAttempts: 0,
      parcelExpiryDate: aSecondAgo,
      parcelObjectKey: 'expired.parcel',
      parcelRecipientAddress: '',
    };
    const message = mockStanMessage(Buffer.from(JSON.stringify(messageData)));
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([message]));

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expect(message.ack).toBeCalledTimes(1);
    expect(pohttp.deliverParcel).not.toBeCalled();

    expect(MOCK_RETRIEVE_INTERNET_PARCEL).not.toBeCalled();
    expect(MOCK_DELETE_INTERNET_PARCEL).toBeCalledWith(messageData.parcelObjectKey);
  });

  test('Parcel should be skipped if its object cannot be found', async () => {
    const stanMessage = mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED);
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([stanMessage]));
    MOCK_RETRIEVE_INTERNET_PARCEL.mockResolvedValue(null);

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expect(pohttp.deliverParcel).not.toBeCalled();
    expect(stanMessage.ack).toBeCalled();
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('warn', 'Parcel object could not be found', {
        parcelObjectKey: QUEUE_MESSAGE_DATA.parcelObjectKey,
        worker: WORKER_NAME,
      }),
    );
  });

  test('Parcel should be posted to server specified in queue message', async () => {
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(
      arrayToAsyncIterable([mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED)]),
    );

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expect(pohttp.deliverParcel).toBeCalledTimes(1);
    expect(pohttp.deliverParcel).toBeCalledWith(
      QUEUE_MESSAGE_DATA.parcelRecipientAddress,
      PARCEL_SERIALIZED,
      expect.anything(),
    );
  });

  test('Parcels should be retrieved from the right bucket', async () => {
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(
      arrayToAsyncIterable([mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED)]),
    );

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expect(MOCK_RETRIEVE_INTERNET_PARCEL.mock.instances[0]).toHaveProperty(
      'bucket',
      ENV_VARS.OBJECT_STORE_BUCKET,
    );
  });

  test('Gateway address should be specified when delivering parcel', async () => {
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(
      arrayToAsyncIterable([mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED)]),
    );

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expect(pohttp.deliverParcel).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        gatewayAddress: OWN_POHTTP_ADDRESS,
      }),
    );
  });

  test('Parcel should be deleted and taken off queue when successfully delivered', async () => {
    const message = mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED);
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([message]));

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);
    expectMessageToBeDiscarded(message);
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('debug', 'Parcel was successfully delivered', {
        parcelObjectKey: QUEUE_MESSAGE_DATA.parcelObjectKey,
        worker: WORKER_NAME,
      }),
    );
  });

  test('Parcel should be discarded when server refuses it invalid', async () => {
    const err = new pohttp.PoHTTPInvalidParcelError('Parcel smells funny');
    getMockInstance(pohttp.deliverParcel).mockRejectedValue(err);
    const message = mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED);
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([message]));

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expectMessageToBeDiscarded(message);
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Parcel was rejected as invalid', {
        parcelObjectKey: QUEUE_MESSAGE_DATA.parcelObjectKey,
        reason: err.message,
        worker: WORKER_NAME,
      }),
    );
  });

  test('Parcel should be discarded if server claims we violated binding', async () => {
    const err = new pohttp.PoHTTPClientBindingError('I did not understand that');
    getMockInstance(pohttp.deliverParcel).mockRejectedValue(err);
    const message = mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED);
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([message]));

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expectMessageToBeDiscarded(message);
    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Discarding parcel due to binding issue', {
        parcelObjectKey: QUEUE_MESSAGE_DATA.parcelObjectKey,
        reason: err.message,
        worker: WORKER_NAME,
      }),
    );
  });

  test('Parcel should be redelivered later if transient delivery error occurs', async () => {
    const err = new pohttp.PoHTTPError('Server is down');
    getMockInstance(pohttp.deliverParcel).mockRejectedValue(err);
    const message = mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED);
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([message]));

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Failed to deliver parcel; will try again later', {
        err: expect.objectContaining({ type: err.name }),
        parcelObjectKey: QUEUE_MESSAGE_DATA.parcelObjectKey,
        worker: WORKER_NAME,
      }),
    );
    expect(message.ack).toBeCalled();
    const expectedMessageData: QueuedInternetBoundParcelMessage = {
      ...QUEUE_MESSAGE_DATA,
      deliveryAttempts: 1,
    };
    expect(MOCK_NATS_CLIENT.publishMessage).toBeCalledWith(
      JSON.stringify(expectedMessageData),
      'internet-parcels',
      'retry',
    );
    expect(MOCK_DELETE_INTERNET_PARCEL).not.toBeCalled();
  });

  test('Parcel redelivery should be attempted up to 3 times', async () => {
    const err = new pohttp.PoHTTPError('Server is down');
    getMockInstance(pohttp.deliverParcel).mockRejectedValue(err);
    const message = mockStanMessage(
      Buffer.from(JSON.stringify({ ...QUEUE_MESSAGE_DATA, deliveryAttempts: 2 })),
    );
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([message]));

    await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

    expect(mockLogging.logs).toContainEqual(
      partialPinoLog('info', 'Failed to deliver parcel again; will now give up', {
        err: expect.objectContaining({ type: err.name }),
        parcelObjectKey: QUEUE_MESSAGE_DATA.parcelObjectKey,
        worker: WORKER_NAME,
      }),
    );
    expect(message.ack).toBeCalled();
    expect(MOCK_NATS_CLIENT.publishMessage).not.toBeCalled();
    expect(MOCK_DELETE_INTERNET_PARCEL).toBeCalled();
  });

  test('Non-PoHTTP errors should be propagated', async () => {
    const err = new Error('This is a bug');
    getMockInstance(pohttp.deliverParcel).mockRejectedValue(err);
    const message = mockStanMessage(QUEUE_MESSAGE_DATA_SERIALIZED);
    MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([message]));

    await expect(processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS)).rejects.toEqual(err);

    expect(message.ack).not.toBeCalled();
    expect(MOCK_NATS_CLIENT.publishMessage).not.toBeCalled();
    expect(MOCK_DELETE_INTERNET_PARCEL).not.toBeCalled();
  });

  describe('NATS Streaming connection', () => {
    test('NAT Streaming client id should match worker name', async () => {
      MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([]));

      await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

      expect(MOCK_NATS_CLIENT_INIT).toBeCalledWith(WORKER_NAME);
    });
  });

  describe('NATS Streaming Consumer', () => {
    test('Channel should be "internet-parcels"', async () => {
      MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([]));

      await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

      expect(MOCK_NATS_CLIENT.makeQueueConsumer).toBeCalledWith(
        'internet-parcels',
        expect.anything(),
        expect.anything(),
      );
    });

    test('Queue should be "worker"', async () => {
      MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([]));

      await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

      expect(MOCK_NATS_CLIENT.makeQueueConsumer).toBeCalledWith(
        expect.anything(),
        'worker',
        expect.anything(),
      );
    });

    test('Durable name should be "worker"', async () => {
      MOCK_NATS_CLIENT.makeQueueConsumer.mockReturnValue(arrayToAsyncIterable([]));

      await processInternetBoundParcels(WORKER_NAME, OWN_POHTTP_ADDRESS);

      expect(MOCK_NATS_CLIENT.makeQueueConsumer).toBeCalledWith(
        expect.anything(),
        expect.anything(),
        'worker',
      );
    });
  });
});

function expectMessageToBeDiscarded(message: Message): void {
  expect(message.ack).toBeCalledTimes(1);
  expect(MOCK_NATS_CLIENT.publishMessage).not.toBeCalled();
  expect(MOCK_DELETE_INTERNET_PARCEL).toBeCalledWith(QUEUE_MESSAGE_DATA.parcelObjectKey);
}
