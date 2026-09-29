import {
  blueskySessionResponseSchema,
  parseBlueskySessionResponse,
  parseBlueskyResolveHandleResponse,
  parseBlueskyDIDDocument,
  parseBlueskyProtectedResourceMetadata,
  parseBlueskyAuthorizationServerMetadata,
  parseBlueskyPushedAuthorizationResponse,
  parseBlueskyTokenResponse,
  blueskyScopeIncludesAtproto,
  normalizeBlueskyHandle,
  createBlueskyDIDDocumentURL,
  parseBlueskyServerOrigin,
  findBlueskyPDSURL,
  blueskyDIDDocumentClaimsHandle,
  createBlueskyClientMetadata,
  parseBlueskyCallbackParameters,
  blueskyOAuthProvider,
  createBlueskyAuthorizationURL,
  parseBlueskyUserFromResponse,
} from './provider.ts';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';

const validSession = {
  did: DID,
  handle: 'alice.bsky.social',
  email: 'alice@example.com',
  emailConfirmed: true,
  active: true,
};

const validDIDDocument = {
  '@context': ['https://www.w3.org/ns/did/v1'],
  id: DID,
  alsoKnownAs: ['at://alice.bsky.social'],
  verificationMethod: [],
  service: [
    {
      id: '#atproto_pds',
      type: 'AtprotoPersonalDataServer',
      serviceEndpoint: 'https://pds.example.com',
    },
  ],
};

const validAuthorizationServerMetadata = {
  issuer: 'https://entryway.example.com',
  authorization_endpoint: 'https://entryway.example.com/oauth/authorize',
  token_endpoint: 'https://entryway.example.com/oauth/token',
  pushed_authorization_request_endpoint: 'https://entryway.example.com/oauth/par',
  require_pushed_authorization_requests: true,
  dpop_signing_alg_values_supported: ['ES256'],
};

const baseParameters = {
  clientID: 'https://worker.example.com/oauth-client-metadata.json',
  redirectURI: 'https://worker.example.com/callback',
  responseType: 'code',
  scopes: ['atproto', 'transition:email'],
  state: 'random-state',
};

describe('blueskySessionResponseSchema', () => {
  test('parses valid payload', () => {
    expect(blueskySessionResponseSchema.safeParse(validSession).success).toBe(true);
  });

  test('requires did and handle', () => {
    expect(blueskySessionResponseSchema.safeParse({}).success).toBe(false);
    expect(blueskySessionResponseSchema.safeParse({ did: DID }).success).toBe(false);
    expect(blueskySessionResponseSchema.safeParse({ handle: 'alice.bsky.social' }).success).toBe(false);
  });

  test('requires did to be a DID', () => {
    expect(blueskySessionResponseSchema.safeParse({ ...validSession, did: 'alice' }).success).toBe(false);
  });

  test('allows a session without email', () => {
    const { email: _, ...noEmail } = validSession;
    expect(blueskySessionResponseSchema.safeParse(noEmail).success).toBe(true);
  });

  test('parseBlueskySessionResponse throws with a descriptive message', () => {
    expect(() => parseBlueskySessionResponse({ did: DID })).toThrow(/Invalid Bluesky session response: handle/);
  });
});

describe('protocol response schemas', () => {
  test('parses a resolveHandle response', () => {
    expect(parseBlueskyResolveHandleResponse({ did: DID }).did).toBe(DID);
    expect(() => parseBlueskyResolveHandleResponse({ did: 'not-a-did' })).toThrow();
  });

  test('parses a DID document and ignores unknown fields', () => {
    const document = parseBlueskyDIDDocument(validDIDDocument);
    expect(document.id).toBe(DID);
    expect(document.alsoKnownAs).toEqual(['at://alice.bsky.social']);
  });

  test('requires at least one authorization server in protected resource metadata', () => {
    expect(parseBlueskyProtectedResourceMetadata({ authorization_servers: ['https://entryway.example.com'] }).authorization_servers)
      .toEqual(['https://entryway.example.com']);
    expect(() => parseBlueskyProtectedResourceMetadata({ authorization_servers: [] })).toThrow();
  });

  test('requires the PAR endpoint in authorization server metadata', () => {
    expect(parseBlueskyAuthorizationServerMetadata(validAuthorizationServerMetadata).issuer)
      .toBe('https://entryway.example.com');

    const { pushed_authorization_request_endpoint: _, ...withoutPAR } = validAuthorizationServerMetadata;
    expect(() => parseBlueskyAuthorizationServerMetadata(withoutPAR)).toThrow(/pushed_authorization_request_endpoint/);
  });

  test('parses a PAR response', () => {
    expect(parseBlueskyPushedAuthorizationResponse({ request_uri: 'urn:ietf:params:oauth:request_uri:abc', expires_in: 299 }).request_uri)
      .toBe('urn:ietf:params:oauth:request_uri:abc');
    expect(() => parseBlueskyPushedAuthorizationResponse({})).toThrow();
  });

  test('requires sub and scope in a token response', () => {
    const tokens = { access_token: 'test-access-token', token_type: 'DPoP', sub: DID, scope: 'atproto transition:email' };
    expect(parseBlueskyTokenResponse(tokens).sub).toBe(DID);

    const { sub: _, ...withoutSub } = tokens;
    expect(() => parseBlueskyTokenResponse(withoutSub)).toThrow(/sub/);

    const { scope: __, ...withoutScope } = tokens;
    expect(() => parseBlueskyTokenResponse(withoutScope)).toThrow(/scope/);
  });

  test('checks the granted scope for atproto', () => {
    expect(blueskyScopeIncludesAtproto('atproto transition:email')).toBe(true);
    expect(blueskyScopeIncludesAtproto('transition:email')).toBe(false);
    expect(blueskyScopeIncludesAtproto('atprotox')).toBe(false);
  });
});

describe('normalizeBlueskyHandle', () => {
  test('lowercases and strips a leading @', () => {
    expect(normalizeBlueskyHandle('@Alice.Bsky.Social ')).toBe('alice.bsky.social');
  });

  test('accepts custom domain handles', () => {
    expect(normalizeBlueskyHandle('bsky.app')).toBe('bsky.app');
  });

  test('refuses values that are not handles', () => {
    for (const input of ['', 'alice', 'alice..bsky.social', '-alice.bsky.social', 'alice.bsky.social/path', 'did:plc:abc', undefined, null]) {
      expect(normalizeBlueskyHandle(input)).toBeUndefined();
    }
  });

  test('refuses disallowed top-level domains', () => {
    expect(normalizeBlueskyHandle('handle.invalid')).toBeUndefined();
    expect(normalizeBlueskyHandle('alice.local')).toBeUndefined();
  });
});

describe('createBlueskyDIDDocumentURL', () => {
  test('resolves did:plc through plc.directory', () => {
    expect(createBlueskyDIDDocumentURL(DID)).toBe(`https://plc.directory/${DID}`);
  });

  test('resolves did:web through /.well-known/did.json', () => {
    expect(createBlueskyDIDDocumentURL('did:web:alice.example.com')).toBe('https://alice.example.com/.well-known/did.json');
  });

  test('refuses unsupported or malformed DIDs', () => {
    for (const did of ['did:key:z6Mk', 'did:plc:short', 'did:web:localhost%3A8080', 'did:web:example.com:path']) {
      expect(createBlueskyDIDDocumentURL(did)).toBeUndefined();
    }
  });
});

describe('parseBlueskyServerOrigin', () => {
  test('accepts bare https origins', () => {
    expect(parseBlueskyServerOrigin('https://bsky.social')).toBe('https://bsky.social');
    expect(parseBlueskyServerOrigin('https://bsky.social/')).toBe('https://bsky.social');
  });

  test('refuses non-https, paths, queries and credentials', () => {
    for (const value of ['http://bsky.social', 'https://bsky.social/oauth', 'https://bsky.social?x=1', 'https://user:pass@bsky.social', 'javascript:alert(1)', 42]) {
      expect(parseBlueskyServerOrigin(value)).toBeUndefined();
    }
  });
});

describe('DID document helpers', () => {
  test('finds the atproto PDS service', () => {
    expect(findBlueskyPDSURL(parseBlueskyDIDDocument(validDIDDocument))).toBe('https://pds.example.com');
  });

  test('accepts a fully qualified service id', () => {
    const document = parseBlueskyDIDDocument({
      ...validDIDDocument,
      service: [{ id: `${DID}#atproto_pds`, type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example.com' }],
    });
    expect(findBlueskyPDSURL(document)).toBe('https://pds.example.com');
  });

  test('returns undefined without a usable PDS service', () => {
    const document = parseBlueskyDIDDocument({
      ...validDIDDocument,
      service: [{ id: '#atproto_pds', type: 'SomethingElse', serviceEndpoint: 'https://pds.example.com' }],
    });
    expect(findBlueskyPDSURL(document)).toBeUndefined();
    expect(findBlueskyPDSURL(parseBlueskyDIDDocument({ id: DID }))).toBeUndefined();
  });

  test('verifies the handle against the primary alias', () => {
    const document = parseBlueskyDIDDocument(validDIDDocument);
    expect(blueskyDIDDocumentClaimsHandle(document, 'alice.bsky.social')).toBe(true);
    expect(blueskyDIDDocumentClaimsHandle(document, 'Alice.Bsky.Social')).toBe(true);
    expect(blueskyDIDDocumentClaimsHandle(document, 'mallory.bsky.social')).toBe(false);
  });

  test('does not accept a handle listed only after the primary alias', () => {
    const document = parseBlueskyDIDDocument({
      ...validDIDDocument,
      alsoKnownAs: ['at://alice.bsky.social', 'at://mallory.bsky.social'],
    });
    expect(blueskyDIDDocumentClaimsHandle(document, 'mallory.bsky.social')).toBe(false);
  });
});

describe('createBlueskyClientMetadata', () => {
  test('derives every URL from the worker origin', () => {
    const metadata = createBlueskyClientMetadata('https://worker.example.com');

    expect(metadata).toEqual({
      client_id: 'https://worker.example.com/oauth-client-metadata.json',
      client_name: 'Audio Underview',
      redirect_uris: ['https://worker.example.com/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'atproto transition:email',
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'ES256',
      dpop_bound_access_tokens: true,
      application_type: 'web',
      jwks_uri: 'https://worker.example.com/jwks.json',
    });
  });
});

describe('blueskyOAuthProvider.buildAuthorizationURL', () => {
  test('builds the authorization URL from the PAR request_uri', () => {
    const url = new URL(blueskyOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      additionalParameters: {
        request_uri: 'urn:ietf:params:oauth:request_uri:abc',
        authorization_endpoint: 'https://entryway.example.com/oauth/authorize',
      },
    }));

    expect(url.origin + url.pathname).toBe('https://entryway.example.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(baseParameters.clientID);
    expect(url.searchParams.get('request_uri')).toBe('urn:ietf:params:oauth:request_uri:abc');
    // Everything else travelled in the PAR body.
    expect([...url.searchParams.keys()].sort()).toEqual(['client_id', 'request_uri']);
  });

  test('defaults to the bsky.social authorization endpoint', () => {
    const url = new URL(blueskyOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      additionalParameters: { request_uri: 'urn:ietf:params:oauth:request_uri:abc' },
    }));

    expect(url.origin + url.pathname).toBe('https://bsky.social/oauth/authorize');
  });

  test('throws without a request_uri', () => {
    expect(() => blueskyOAuthProvider.buildAuthorizationURL(baseParameters)).toThrow(/request_uri/);
  });
});

describe('createBlueskyAuthorizationURL', () => {
  test('matches the provider implementation', () => {
    const url = new URL(createBlueskyAuthorizationURL(
      baseParameters.clientID,
      'urn:ietf:params:oauth:request_uri:abc',
      { authorizationEndpoint: 'https://entryway.example.com/oauth/authorize' },
    ));

    expect(url.origin + url.pathname).toBe('https://entryway.example.com/oauth/authorize');
    expect(url.searchParams.get('request_uri')).toBe('urn:ietf:params:oauth:request_uri:abc');
  });
});

describe('blueskyOAuthProvider.parseCallbackParameters', () => {
  test('parses code, state and iss', () => {
    const result = parseBlueskyCallbackParameters(
      'https://worker.example.com/callback?code=bluesky-code&state=st&iss=https%3A%2F%2Fentryway.example.com',
    );
    expect(result.code).toBe('bluesky-code');
    expect(result.state).toBe('st');
    expect(result.issuer).toBe('https://entryway.example.com');
  });

  test('parses error', () => {
    const result = blueskyOAuthProvider.parseCallbackParameters(
      'https://worker.example.com/callback?error=access_denied&error_description=Denied',
    );
    expect(result.error).toBe('access_denied');
    expect(result.errorDescription).toBe('Denied');
  });
});

describe('blueskyOAuthProvider.parseUserData', () => {
  test('maps the session to OAuthUser with the DID as id and the handle as name', () => {
    const user = blueskyOAuthProvider.parseUserData(validSession);
    expect(user.id).toBe(DID);
    expect(user.name).toBe('alice.bsky.social');
    expect(user.email).toBe('alice@example.com');
    expect(user.provider).toBe('bluesky');
    expect(user.picture).toBeUndefined();
  });

  test('omits email when the session carries none', () => {
    const { email: _, ...noEmail } = validSession;
    const user = blueskyOAuthProvider.parseUserData(noEmail);
    expect('email' in user).toBe(false);
  });
});

describe('parseBlueskyUserFromResponse', () => {
  test('delegates to parseUserData', () => {
    const user = parseBlueskyUserFromResponse(validSession);
    expect(user.provider).toBe('bluesky');
  });
});
