import { render_endpoint } from './endpoint.js';
import { render_page } from './page/index.js';
import { render_response } from './page/render.js';
import { respond_with_error } from './page/respond_with_error.js';
import { coalesce_to_error, normalize_error } from '../../utils/error.js';
import { serialize_error, GENERIC_ERROR, error_to_pojo } from './utils.js';
import { decode_params, normalize_path } from '../../utils/url.js';
import { exec } from '../../utils/routing.js';
import { negotiate } from '../../utils/http.js';
import { HttpError, Redirect } from '../../index/private.js';
import { load_server_data } from './page/load_data.js';
import { json } from '../../index/index.js';

/* global __SVELTEKIT_ADAPTER_NAME__ */

const DATA_SUFFIX = '/__data.json';

/** @param {{ html: string }} opts */
const default_transform = ({ html }) => html;

/** @type {import('types').Respond} */
export async function respond(request, options, state) {
	let url = new URL(request.url);

	const { parameter, allowed } = options.method_override;
	const method_override = url.searchParams.get(parameter)?.toUpperCase();

	if (method_override) {
		if (request.method === 'POST') {
			if (allowed.includes(method_override)) {
				request = new Proxy(request, {
					get: (target, property, _receiver) => {
						if (property === 'method') return method_override;
						return Reflect.get(target, property, target);
					}
				});
			} else {
				const verb = allowed.length === 0 ? 'enabled' : 'allowed';
				const body = `${parameter}=${method_override} is not ${verb}. See https://kit.svelte.dev/docs/configuration#methodoverride`;

				return new Response(body, {
					status: 400
				});
			}
		} else {
			throw new Error(`${parameter}=${method_override} is only allowed with POST requests`);
		}
	}

	let decoded;
	try {
		decoded = decodeURI(url.pathname);
	} catch {
		return new Response('Malformed URI', { status: 400 });
	}

	/** @type {import('types').SSRRoute | null} */
	let route = null;

	/** @type {Record<string, string>} */
	let params = {};

	if (options.paths.base && !state.prerendering?.fallback) {
		if (!decoded.startsWith(options.paths.base)) {
			return new Response('Not found', { status: 404 });
		}
		decoded = decoded.slice(options.paths.base.length) || '/';
	}

	const is_data_request = decoded.endsWith(DATA_SUFFIX);

	if (is_data_request) {
		const data_suffix_length = DATA_SUFFIX.length - (options.trailing_slash === 'always' ? 1 : 0);
		decoded = decoded.slice(0, -data_suffix_length) || '/';
		url = new URL(url.origin + url.pathname.slice(0, -data_suffix_length) + url.search);
	}

	if (!state.prerendering?.fallback) {
		const matchers = await options.manifest._.matchers();

		for (const candidate of options.manifest._.routes) {
			const match = candidate.pattern.exec(decoded);
			if (!match) continue;

			const matched = exec(match, candidate.names, candidate.types, matchers);
			if (matched) {
				route = candidate;
				params = decode_params(matched);
				break;
			}
		}
	}

	if (route) {
		if (route.type === 'page') {
			const normalized = normalize_path(url.pathname, options.trailing_slash);

			if (normalized !== url.pathname && !state.prerendering?.fallback) {
				return new Response(undefined, {
					status: 301,
					headers: {
						'x-sveltekit-normalize': '1',
						location:
							// ensure paths starting with '//' are not treated as protocol-relative
							(normalized.startsWith('//') ? url.origin + normalized : normalized) +
							(url.search === '?' ? '' : url.search)
					}
				});
			}
		} else if (is_data_request) {
			// requesting /__data.json should fail for a standalone endpoint
			return new Response(undefined, {
				status: 404
			});
		}
	}

	/** @type {import('types').ResponseHeaders} */
	const headers = {};

	/** @type {import('types').RequestEvent} */
	const event = {
		get clientAddress() {
			if (!state.getClientAddress) {
				throw new Error(
					`${__SVELTEKIT_ADAPTER_NAME__} does not specify getClientAddress. Please raise an issue`
				);
			}

			Object.defineProperty(event, 'clientAddress', {
				value: state.getClientAddress()
			});

			return event.clientAddress;
		},
		locals: {},
		params,
		platform: state.platform,
		request,
		routeId: route && route.id,
		setHeaders: (new_headers) => {
			for (const key in new_headers) {
				const lower = key.toLowerCase();

				if (lower in headers) {
					throw new Error(`"${key}" header is already set`);
				}

				// TODO apply these headers to the response
				headers[lower] = new_headers[key];

				if (state.prerendering && lower === 'cache-control') {
					state.prerendering.cache = /** @type {string} */ (new_headers[key]);
				}
			}
		},
		url
	};

	// TODO remove this for 1.0
	/**
	 * @param {string} property
	 * @param {string} replacement
	 * @param {string} suffix
	 */
	const removed = (property, replacement, suffix = '') => ({
		get: () => {
			throw new Error(`event.${property} has been replaced by event.${replacement}` + suffix);
		}
	});

	const details = '. See https://github.com/sveltejs/kit/pull/3384 for details';

	const body_getter = {
		get: () => {
			throw new Error(
				'To access the request body use the text/json/arrayBuffer/formData methods, e.g. `body = await request.json()`' +
					details
			);
		}
	};

	Object.defineProperties(event, {
		method: removed('method', 'request.method', details),
		headers: removed('headers', 'request.headers', details),
		origin: removed('origin', 'url.origin'),
		path: removed('path', 'url.pathname'),
		query: removed('query', 'url.searchParams'),
		body: body_getter,
		rawBody: body_getter
	});

	/** @type {import('types').RequiredResolveOptions} */
	let resolve_opts = {
		ssr: true,
		transformPageChunk: default_transform
	};

	// TODO match route before calling handle?

	try {
		const response = await options.hooks.handle({
			event,
			resolve: async (event, opts) => {
				if (opts) {
					// TODO remove for 1.0
					// @ts-expect-error
					if (opts.transformPage) {
						throw new Error(
							'transformPage has been replaced by transformPageChunk — see https://github.com/sveltejs/kit/pull/5657 for more information'
						);
					}

					resolve_opts = {
						ssr: opts.ssr !== false,
						transformPageChunk: opts.transformPageChunk || default_transform
					};
				}

				if (state.prerendering?.fallback) {
					return await render_response({
						event,
						options,
						state,
						$session: await options.hooks.getSession(event),
						page_config: { router: true, hydrate: true },
						status: 200,
						error: null,
						branch: [],
						fetched: [],
						validation_errors: undefined,
						cookies: [],
						resolve_opts: {
							...resolve_opts,
							ssr: false
						}
					});
				}

				if (route) {
					/** @type {Response} */
					let response;
					if (is_data_request && route.type === 'page') {
						try {
							/** @type {Redirect | HttpError | Error} */
							let error;

							// TODO only get the data we need for the navigation
							const promises = [...route.layouts, route.leaf].map(async (n, i) => {
								try {
									if (error) return;

									const node = n ? await options.manifest._.nodes[n]() : undefined;
									return {
										// TODO return `uses`, so we can reuse server data effectively
										data: await load_server_data({
											event,
											node,
											parent: async () => {
												/** @type {import('types').JSONObject} */
												const data = {};
												for (let j = 0; j < i; j += 1) {
													Object.assign(data, await promises[j]);
												}
												return data;
											}
										})
									};
								} catch (e) {
									error = normalize_error(e);

									if (error instanceof Redirect) {
										throw error;
									}

									if (error instanceof HttpError) {
										return error; // { status, message }
									}

									options.handle_error(error, event);

									return {
										error: error_to_pojo(error, options.get_stack)
									};
								}
							});

							response = json({
								type: 'data',
								nodes: await Promise.all(promises)
							});
						} catch (e) {
							const error = normalize_error(e);

							if (error instanceof Redirect) {
								response = json({
									type: 'redirect',
									location: error.location
								});
							} else {
								response = json(error_to_pojo(error, options.get_stack), { status: 500 });
							}
						}
					} else {
						response =
							route.type === 'endpoint'
								? await render_endpoint(event, route)
								: await render_page(event, route, options, state, resolve_opts);
					}

					for (const key in headers) {
						const value = headers[key];
						if (key === 'set-cookie') {
							for (const cookie of Array.isArray(value) ? value : [value]) {
								response.headers.append(key, /** @type {string} */ (cookie));
							}
						} else if (!is_data_request) {
							// we only want to set cookies on __data.json requests, we don't
							// want to cache stuff erroneously etc
							response.headers.set(key, /** @type {string} */ (value));
						}
					}

					// respond with 304 if etag matches
					if (response.status === 200 && response.headers.has('etag')) {
						let if_none_match_value = request.headers.get('if-none-match');

						// ignore W/ prefix https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match#directives
						if (if_none_match_value?.startsWith('W/"')) {
							if_none_match_value = if_none_match_value.substring(2);
						}

						const etag = /** @type {string} */ (response.headers.get('etag'));

						if (if_none_match_value === etag) {
							const headers = new Headers({ etag });

							// https://datatracker.ietf.org/doc/html/rfc7232#section-4.1
							for (const key of ['cache-control', 'content-location', 'date', 'expires', 'vary']) {
								const value = response.headers.get(key);
								if (value) headers.set(key, value);
							}

							return new Response(undefined, {
								status: 304,
								headers
							});
						}
					}

					return response;
				}

				if (state.initiator === GENERIC_ERROR) {
					return new Response('Internal Server Error', {
						status: 500
					});
				}

				// if this request came direct from the user, rather than
				// via a `fetch` in a `load`, render a 404 page
				if (!state.initiator) {
					const $session = await options.hooks.getSession(event);
					return await respond_with_error({
						event,
						options,
						state,
						$session,
						status: 404,
						error: new Error(`Not found: ${event.url.pathname}`),
						resolve_opts
					});
				}

				if (state.prerendering) {
					return new Response('not found', { status: 404 });
				}

				// we can't load the endpoint from our own manifest,
				// so we need to make an actual HTTP request
				return await fetch(request);
			},

			// TODO remove for 1.0
			// @ts-expect-error
			get request() {
				throw new Error('request in handle has been replaced with event' + details);
			}
		});

		// TODO for 1.0, change the error message to point to docs rather than PR
		if (response && !(response instanceof Response)) {
			throw new Error('handle must return a Response object' + details);
		}

		return response;
	} catch (/** @type {unknown} */ e) {
		const error = coalesce_to_error(e);

		options.handle_error(error, event);

		const type = negotiate(event.request.headers.get('accept') || 'text/html', [
			'text/html',
			'application/json'
		]);

		if (is_data_request || type === 'application/json') {
			return new Response(serialize_error(error, options.get_stack), {
				status: 500,
				headers: { 'content-type': 'application/json; charset=utf-8' }
			});
		}

		// TODO is this necessary? should we just return a plain 500 at this point?
		try {
			const $session = await options.hooks.getSession(event);
			return await respond_with_error({
				event,
				options,
				state,
				$session,
				status: 500,
				error,
				resolve_opts
			});
		} catch (/** @type {unknown} */ e) {
			const error = coalesce_to_error(e);

			return new Response(options.dev ? error.stack : error.message, {
				status: 500
			});
		}
	}
}
