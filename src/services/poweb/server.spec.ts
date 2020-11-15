// tslint:disable:no-let

import { mockSpy } from '../../_test_utils';
import * as fastifyUtils from '../fastifyUtils';
import { setUpCommonFixtures } from './_test_utils';
import RouteOptions from './RouteOptions';
import { makeServer } from './server';

const getFixtures = setUpCommonFixtures();

const mockFastifyInstance = {};
const mockConfigureFastify = mockSpy(
  jest.spyOn(fastifyUtils, 'configureFastify'),
  () => mockFastifyInstance,
);

describe('makeServer', () => {
  test('Function to retrieve the key pair should be added to the options', async () => {
    await makeServer();

    const routeOptions = mockConfigureFastify.mock.calls[0][1] as RouteOptions;
    const retriever = routeOptions.keyPairRetriever;
    const retrieverCertificate = (await retriever()).certificate;
    expect(retrieverCertificate.isEqual(getFixtures().publicGatewayCert)).toBeTrue();
  });

  test('No logger should be passed by default', async () => {
    await makeServer();

    expect(mockConfigureFastify).toBeCalledWith(expect.anything(), expect.anything(), undefined);
  });

  test('Any explicit logger should be honored', async () => {
    const logger: fastifyUtils.FastifyLogger = { level: 'debug' };

    await makeServer(logger);

    expect(mockConfigureFastify).toBeCalledWith(expect.anything(), expect.anything(), logger);
  });

  test('Fastify instance should be returned', async () => {
    await expect(makeServer()).resolves.toEqual(mockFastifyInstance);
  });
});
