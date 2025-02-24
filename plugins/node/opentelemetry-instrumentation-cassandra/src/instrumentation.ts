/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  context,
  trace,
  Span,
  Attributes,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
  isWrapped,
  safeExecuteInTheMiddle,
} from '@opentelemetry/instrumentation';
import { CassandraDriverInstrumentationConfig, ResultSet } from './types';
import {
  DBSYSTEMVALUES_CASSANDRA,
  SEMATTRS_DB_NAME,
  SEMATTRS_DB_STATEMENT,
  SEMATTRS_DB_SYSTEM,
  SEMATTRS_DB_USER,
  SEMATTRS_NET_PEER_NAME,
  SEMATTRS_NET_PEER_PORT,
} from '@opentelemetry/semantic-conventions';
/** @knipignore */
import { PACKAGE_NAME, PACKAGE_VERSION } from './version';
import { EventEmitter } from 'events';
import type * as CassandraDriver from 'cassandra-driver';

const supportedVersions = ['>=4.4.0 <5'];

export class CassandraDriverInstrumentation extends InstrumentationBase<CassandraDriverInstrumentationConfig> {
  constructor(config: CassandraDriverInstrumentationConfig = {}) {
    super(PACKAGE_NAME, PACKAGE_VERSION, config);
  }

  protected init() {
    return new InstrumentationNodeModuleDefinition(
      'cassandra-driver',
      supportedVersions,
      driverModule => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Client = driverModule.Client.prototype as any;

        if (isWrapped(Client['_execute'])) {
          this._unwrap(Client, '_execute');
        }

        if (isWrapped(Client.batch)) {
          this._unwrap(Client, 'batch');
        }

        if (isWrapped(Client.stream)) {
          this._unwrap(Client, 'stream');
        }

        this._wrap(Client, '_execute', this._getPatchedExecute());
        this._wrap(Client, 'batch', this._getPatchedBatch());
        this._wrap(Client, 'stream', this._getPatchedStream());

        return driverModule;
      },
      driverModule => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Client = driverModule.Client.prototype as any;

        if (isWrapped(Client['_execute'])) {
          this._unwrap(Client, '_execute');
        }

        if (isWrapped(Client.batch)) {
          this._unwrap(Client, 'batch');
        }

        if (isWrapped(Client.stream)) {
          this._unwrap(Client, 'stream');
        }
      },
      [
        new InstrumentationNodeModuleFile(
          'cassandra-driver/lib/request-execution.js',
          supportedVersions,
          execution => {
            if (isWrapped(execution.prototype['_sendOnConnection'])) {
              this._unwrap(execution.prototype, '_sendOnConnection');
            }

            this._wrap(
              execution.prototype,
              '_sendOnConnection',
              this._getPatchedSendOnConnection()
            );
            return execution;
          },
          execution => {
            if (execution === undefined) return;
            this._unwrap(execution.prototype, '_sendOnConnection');
          }
        ),
      ]
    );
  }

  private _getMaxQueryLength(): number {
    return this.getConfig().maxQueryLength ?? 65536;
  }

  private _shouldIncludeDbStatement(): boolean {
    return this.getConfig().enhancedDatabaseReporting ?? false;
  }

  private _getPatchedExecute() {
    return (
      original: (...args: unknown[]) => Promise<CassandraDriver.types.ResultSet>
    ) => {
      const plugin = this;
      return function patchedExecute(
        this: CassandraDriver.Client,
        ...args: unknown[]
      ) {
        const span = plugin.startSpan({ op: 'execute', query: args[0] }, this);

        const execContext = trace.setSpan(context.active(), span);
        const execPromise = safeExecuteInTheMiddle(
          () => {
            return context.with(execContext, () => {
              return original.apply(this, args);
            });
          },
          error => {
            if (error) {
              failSpan(span, error);
            }
          }
        );

        const wrappedPromise = wrapPromise(
          span,
          execPromise,
          (span, result) => {
            plugin._callResponseHook(span, result);
          }
        );

        return context.bind(execContext, wrappedPromise);
      };
    };
  }

  private _getPatchedSendOnConnection() {
    return (original: (...args: unknown[]) => unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return function patchedSendOnConnection(this: any, ...args: unknown[]) {
        const span = trace.getSpan(context.active());
        const conn = this['_connection'];

        if (span !== undefined && conn !== undefined) {
          const port = parseInt(conn.port, 10);

          span.setAttribute(SEMATTRS_NET_PEER_NAME, conn.address);

          if (!isNaN(port)) {
            span.setAttribute(SEMATTRS_NET_PEER_PORT, port);
          }
        }

        return original.apply(this, args);
      };
    };
  }

  private _getPatchedBatch() {
    return (original: (...args: unknown[]) => unknown) => {
      const plugin = this;
      return function patchedBatch(
        this: CassandraDriver.Client,
        ...args: unknown[]
      ) {
        const queries = Array.isArray(args[0]) ? args[0] : [];
        const span = plugin.startSpan(
          { op: 'batch', query: combineQueries(queries) },
          this
        );

        const batchContext = trace.setSpan(context.active(), span);

        if (typeof args[args.length - 1] === 'function') {
          const originalCallback = args[
            args.length - 1
          ] as CassandraDriver.ValueCallback<CassandraDriver.types.ResultSet>;

          const patchedCallback = function (
            this: unknown,
            ...cbArgs: Parameters<typeof originalCallback>
          ) {
            const error = cbArgs[0];

            if (error) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error.message,
              });
              span.recordException(error);
            }

            span.end();

            return originalCallback.apply(this, cbArgs);
          };

          args[args.length - 1] = patchedCallback;

          return context.with(batchContext, () => {
            return original.apply(this, args);
          });
        }

        const batchPromise = safeExecuteInTheMiddle(
          () => {
            return original.apply(
              this,
              args
            ) as Promise<CassandraDriver.types.ResultSet>;
          },
          error => {
            if (error) {
              failSpan(span, error);
            }
          }
        );

        const wrappedPromise = wrapPromise(span, batchPromise);

        return context.bind(batchContext, wrappedPromise);
      };
    };
  }

  private _getPatchedStream() {
    return (original: (...args: unknown[]) => EventEmitter) => {
      const plugin = this;
      return function patchedStream(
        this: CassandraDriver.Client,
        ...args: unknown[]
      ) {
        // Since stream internally uses execute, there is no need to add DB_STATEMENT twice
        const span = plugin.startSpan({ op: 'stream' }, this);

        const callback = args[3];

        const endSpan = (error: Error) => {
          if (error) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message,
            });
            span.recordException(error);
          }
          span.end();
        };

        if (callback === undefined) {
          args[3] = endSpan;
        } else if (typeof callback === 'function') {
          const wrappedCallback = function (this: unknown, err: Error) {
            endSpan(err);
            return callback.call(this, err);
          };
          args[3] = wrappedCallback;
        }

        return safeExecuteInTheMiddle(
          () => {
            return original.apply(this, args);
          },
          error => {
            if (error) {
              failSpan(span, error);
            }
          }
        );
      };
    };
  }

  private startSpan(
    { op, query }: { op: string; query?: unknown },
    client: CassandraDriver.Client
  ): Span {
    const attributes: Attributes = {
      [SEMATTRS_DB_SYSTEM]: DBSYSTEMVALUES_CASSANDRA,
    };

    if (this._shouldIncludeDbStatement() && query !== undefined) {
      const statement = truncateQuery(query, this._getMaxQueryLength());
      attributes[SEMATTRS_DB_STATEMENT] = statement;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = (client as any).options?.credentials?.username;

    if (user) {
      attributes[SEMATTRS_DB_USER] = user;
    }

    if (client.keyspace) {
      attributes[SEMATTRS_DB_NAME] = client.keyspace;
    }

    return this.tracer.startSpan(`cassandra-driver.${op}`, {
      kind: SpanKind.CLIENT,
      attributes,
    });
  }

  private _callResponseHook(span: Span, response: ResultSet) {
    const { responseHook } = this.getConfig();
    if (!responseHook) {
      return;
    }

    safeExecuteInTheMiddle(
      () => responseHook(span, { response: response }),
      e => {
        if (e) {
          this._diag.error('responseHook error', e);
        }
      },
      true
    );
  }
}

function failSpan(span: Span, error: Error) {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error.message,
  });
  span.recordException(error);
  span.end();
}

function combineQueries(queries: Array<string | { query: string }>) {
  return queries
    .map(query => (typeof query === 'string' ? query : query.query))
    .join('\n');
}

function wrapPromise<T>(
  span: Span,
  promise: Promise<T>,
  successCallback?: (span: Span, result: T) => void
): Promise<T> {
  return promise
    .then(result => {
      return new Promise<T>(resolve => {
        if (successCallback) {
          successCallback(span, result);
        }
        span.end();
        resolve(result);
      });
    })
    .catch((error: Error) => {
      return new Promise<T>((_, reject) => {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
        span.recordException(error);
        span.end();
        reject(error);
      });
    });
}

function truncateQuery(query: unknown, maxQueryLength: number) {
  return String(query).substring(0, maxQueryLength);
}
