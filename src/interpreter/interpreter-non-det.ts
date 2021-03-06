/* tslint:disable:max-classes-per-file */
import * as es from 'estree'
import * as constants from '../constants'
import * as errors from '../errors/errors'
import { RuntimeSourceError } from '../errors/runtimeSourceError'
import { Context, Environment, Frame, Value } from '../types'
import { primitive, conditionalExpression, literal } from '../utils/astCreator'
import { evaluateBinaryExpression, evaluateUnaryExpression } from '../utils/operators'
import * as rttc from '../utils/rttc'
import Closure from './closure'
import { cloneDeep, assignIn } from 'lodash'
import { CUT } from '../constants'

class ReturnValue {
  constructor(public value: Value) {}
}

const createEnvironment = (
  closure: Closure,
  args: Value[],
  callExpression?: es.CallExpression
): Environment => {
  const environment: Environment = {
    name: closure.functionName, // TODO: Change this
    tail: closure.environment,
    head: {}
  }
  if (callExpression) {
    environment.callExpression = {
      ...callExpression,
      arguments: args.map(primitive)
    }
  }
  closure.node.params.forEach((param, index) => {
    const ident = param as es.Identifier
    environment.head[ident.name] = args[index]
  })
  return environment
}

const createBlockEnvironment = (
  context: Context,
  name = 'blockEnvironment',
  head: Frame = {}
): Environment => {
  return {
    name,
    tail: currentEnvironment(context),
    head,
    thisContext: context
  }
}

const handleRuntimeError = (context: Context, error: RuntimeSourceError): never => {
  context.errors.push(error)
  context.runtime.environments = context.runtime.environments.slice(
    -context.numberOfOuterEnvironments
  )
  throw error
}

const DECLARED_BUT_NOT_YET_ASSIGNED = Symbol('Used to implement declaration')

function declareIdentifier(context: Context, name: string, node: es.Node) {
  const environment = currentEnvironment(context)
  if (environment.head.hasOwnProperty(name)) {
    const descriptors = Object.getOwnPropertyDescriptors(environment.head)

    return handleRuntimeError(
      context,
      new errors.VariableRedeclaration(node, name, descriptors[name].writable)
    )
  }
  environment.head[name] = DECLARED_BUT_NOT_YET_ASSIGNED
  return environment
}

function declareVariables(context: Context, node: es.VariableDeclaration) {
  for (const declaration of node.declarations) {
    declareIdentifier(context, (declaration.id as es.Identifier).name, node)
  }
}

function declareFunctionAndVariableIdentifiers(context: Context, node: es.BlockStatement) {
  for (const statement of node.body) {
    switch (statement.type) {
      case 'VariableDeclaration':
        declareVariables(context, statement)
        break
      case 'FunctionDeclaration':
        declareIdentifier(context, (statement.id as es.Identifier).name, statement)
        break
    }
  }
}

function defineVariable(context: Context, name: string, value: Value, constant = false) {
  const environment = context.runtime.environments[0]

  if (environment.head[name] !== DECLARED_BUT_NOT_YET_ASSIGNED) {
    return handleRuntimeError(
      context,
      new errors.VariableRedeclaration(context.runtime.nodes[0]!, name, !constant)
    )
  }

  Object.defineProperty(environment.head, name, {
    value,
    writable: !constant,
    enumerable: true
  })

  return environment
}

const currentEnvironment = (context: Context) => context.runtime.environments[0]
const popEnvironment = (context: Context) => context.runtime.environments.shift()
const pushEnvironment = (context: Context, environment: Environment) =>
  context.runtime.environments.unshift(environment)

const getVariable = (context: Context, name: string) => {
  let environment: Environment | null = context.runtime.environments[0]
  while (environment) {
    if (environment.head.hasOwnProperty(name)) {
      if (environment.head[name] === DECLARED_BUT_NOT_YET_ASSIGNED) {
        return handleRuntimeError(
          context,
          new errors.UnassignedVariable(name, context.runtime.nodes[0])
        )
      } else {
        return environment.head[name]
      }
    } else {
      environment = environment.tail
    }
  }
  return handleRuntimeError(context, new errors.UndefinedVariable(name, context.runtime.nodes[0]))
}

const setVariable = (context: Context, name: string, value: any) => {
  let environment: Environment | null = context.runtime.environments[0]
  while (environment) {
    if (environment.head.hasOwnProperty(name)) {
      if (environment.head[name] === DECLARED_BUT_NOT_YET_ASSIGNED) {
        break
      }
      const descriptors = Object.getOwnPropertyDescriptors(environment.head)
      if (descriptors[name].writable) {
        environment.head[name] = value
        return undefined
      }
      return handleRuntimeError(
        context,
        new errors.ConstAssignment(context.runtime.nodes[0]!, name)
      )
    } else {
      environment = environment.tail
    }
  }
  return handleRuntimeError(context, new errors.UndefinedVariable(name, context.runtime.nodes[0]))
}

const checkNumberOfArguments = (
  context: Context,
  callee: Closure,
  args: Value[],
  exp: es.CallExpression
) => {
  if (callee.node.params.length !== args.length) {
    return handleRuntimeError(
      context,
      new errors.InvalidNumberOfArguments(exp, callee.node.params.length, args.length)
    )
  }
  return undefined
}

function* getArgs(context: Context, call: es.CallExpression) {
  const args = cloneDeep(call.arguments)
  return yield* cartesianProduct(context, args as es.Expression[], [])
}

/* Given a list of non deterministic nodes, this generator returns every
 * combination of values of these nodes */
function* cartesianProduct(
  context: Context,
  nodes: es.Expression[],
  nodeValues: Value[]
): IterableIterator<Value[]> {
  if (nodes.length === 0) {
    yield nodeValues
  } else {
    const currentNode = nodes.shift()! // we need the postfix ! to tell compiler that nodes array is nonempty
    const nodeValueGenerator = evaluate(currentNode, context)
    for (const nodeValue of nodeValueGenerator) {
      nodeValues.push(nodeValue)
      yield* cartesianProduct(context, nodes, nodeValues)
      nodeValues.pop()
    }
    nodes.unshift(currentNode)
  }
}

function* getAmbArgs(context: Context, call: es.CallExpression) {
  const originalContext = cloneDeep(context)
  for (const arg of call.arguments) {
    yield* evaluate(arg, context)
    assignIn(context, cloneDeep(originalContext)) // reset context
  }
}

function transformLogicalExpression(node: es.LogicalExpression): es.ConditionalExpression {
  if (node.operator === '&&') {
    return conditionalExpression(node.left, node.right, literal(false), node.loc!)
  } else {
    return conditionalExpression(node.left, literal(true), node.right, node.loc!)
  }
}

function* reduceIf(
  node: es.IfStatement | es.ConditionalExpression,
  context: Context
): IterableIterator<es.Node> {
  const testGenerator = evaluate(node.test, context)
  for (const test of testGenerator) {
    const error = rttc.checkIfStatement(node, test)
    if (error) {
      return handleRuntimeError(context, error)
    }
    yield test ? node.consequent : node.alternate!
  }
}

export type Evaluator<T extends es.Node> = (node: T, context: Context) => IterableIterator<Value>

function* evaluateBlockSatement(context: Context, node: es.BlockStatement) {
  declareFunctionAndVariableIdentifiers(context, node)
  yield* evaluateSequence(context, node.body)
}

function* evaluateSequence(context: Context, sequence: es.Statement[]): IterableIterator<Value> {
  if (sequence.length === 0) {
    return yield undefined // repl does not work unless we handle this case --> Why?
  }
  const firstStatement = sequence[0]
  const sequenceValGenerator = evaluate(firstStatement, context)
  if (sequence.length === 1) {
    yield* sequenceValGenerator
  } else {
    sequence.shift()
    let shouldUnshift = true
    for (const sequenceValue of sequenceValGenerator) {
      // prevent unshifting of cut operator
      shouldUnshift = sequenceValue !== CUT

      if (sequenceValue instanceof ReturnValue) {
        yield sequenceValue
        continue
      }

      const res = yield* evaluateSequence(context, sequence)
      if (res === CUT) {
        // prevent unshifting of statenents before cut
        shouldUnshift = false
        break
      }
    }

    if (shouldUnshift) sequence.unshift(firstStatement)
    else return CUT
  }
}

function* evaluateConditional(node: es.IfStatement | es.ConditionalExpression, context: Context) {
  const branchGenerator = reduceIf(node, context)
  for (const branch of branchGenerator) {
    yield* evaluate(branch, context)
  }
}

/**
 * WARNING: Do not use object literal shorthands, e.g.
 *   {
 *     *Literal(node: es.Literal, ...) {...},
 *     *ThisExpression(node: es.ThisExpression, ..._ {...},
 *     ...
 *   }
 * They do not minify well, raising uncaught syntax errors in production.
 * See: https://github.com/webpack/webpack/issues/7566
 */
// tslint:disable:object-literal-shorthand
// prettier-ignore
export const evaluators: { [nodeType: string]: Evaluator<es.Node> } = {
  /** Simple Values */
  Literal: function*(node: es.Literal, context: Context) {
    yield node.value
  },

  ArrowFunctionExpression: function*(node: es.ArrowFunctionExpression, context: Context) {
    yield Closure.makeFromArrowFunction(node, currentEnvironment(context), context)
  },

  Identifier: function*(node: es.Identifier, context: Context) {
    if (node.name === 'cut') {
      return yield CUT
    }

    yield getVariable(context, node.name)
    return
  },

  CallExpression: function*(node: es.CallExpression, context: Context) {
    const callee = node.callee;
    if (rttc.isIdentifier(callee)) {
      if (callee.name === 'amb') {
        return yield* getAmbArgs(context, node)
      }
    }

    const calleeGenerator = evaluate(node.callee, context)
    for (const calleeValue of calleeGenerator) {
      const argsGenerator = getArgs(context, node)
      for(const args of argsGenerator) {
        yield* apply(context, calleeValue, args, node, undefined)
      }
    }
  },

  UnaryExpression: function*(node: es.UnaryExpression, context: Context) {
    const argGenerator = evaluate(node.argument, context)
    for (const argValue of argGenerator) {
      const error = rttc.checkUnaryExpression(node, node.operator, argValue)
      if (error) {
        return handleRuntimeError(context, error)
      }
      yield evaluateUnaryExpression(node.operator, argValue)
    }
    return
  },

  BinaryExpression: function*(node: es.BinaryExpression, context: Context) {
    const leftGenerator = evaluate(node.left, context)
    for (const leftValue of leftGenerator) {
      const rightGenerator = evaluate(node.right, context)
      for (const rightValue of rightGenerator) {
        const error = rttc.checkBinaryExpression(node, node.operator, leftValue, rightValue)
        if (error) {
          return handleRuntimeError(context, error)
        }
        yield evaluateBinaryExpression(node.operator, leftValue, rightValue)
      }
    }
    return
  },

  ConditionalExpression: function*(node: es.ConditionalExpression, context: Context) {
    yield* evaluateConditional(node, context)
  },

  LogicalExpression: function*(node: es.LogicalExpression, context: Context) {
    const conditional: es.ConditionalExpression = transformLogicalExpression(node)
    yield* evaluateConditional(conditional, context)
  },

  VariableDeclaration: function*(node: es.VariableDeclaration, context: Context) {
    const declaration = node.declarations[0]
    const constant = node.kind === 'const'
    const id = declaration.id as es.Identifier
    const valueGenerator = evaluate(declaration.init!, context)
    for (const value of valueGenerator) {
      defineVariable(context, id.name, value, constant)
      yield value
    }
    return undefined
  },

  AssignmentExpression: function*(node: es.AssignmentExpression, context: Context) {
    const id = node.left as es.Identifier

    const valueGenerator = evaluate(node.right, context)
    for (const value of valueGenerator) {
      setVariable(context, id.name, value)
      yield value
    }
  },

  FunctionDeclaration: function*(node: es.FunctionDeclaration, context: Context) {
    const id = node.id as es.Identifier
    // tslint:disable-next-line:no-any
    const closure = new Closure(node, currentEnvironment(context), context)
    defineVariable(context, id.name, closure, true)
    yield undefined
  },

  IfStatement: function*(node: es.IfStatement, context: Context) {
    yield* evaluateConditional(node, context)
  },

  ExpressionStatement: function*(node: es.ExpressionStatement, context: Context) {
    return yield* evaluate(node.expression, context)
  },


  ReturnStatement: function*(node: es.ReturnStatement, context: Context) {
    const returnExpression = node.argument!
    const returnValueGenerator = evaluate(returnExpression, context)
    for (const returnValue of returnValueGenerator) {
      yield new ReturnValue(returnValue)
    }
  },

  BlockStatement: function*(node: es.BlockStatement, context: Context) {
    // Create a new environment (block scoping)
    const environment = createBlockEnvironment(context, 'blockEnvironment')
    pushEnvironment(context, environment)

    const resultGenerator = evaluateBlockSatement(context, node)
    for (const result of resultGenerator) {
      popEnvironment(context)
      yield result
      pushEnvironment(context, environment)
    }
    popEnvironment(context)
  },

  Program: function*(node: es.BlockStatement, context: Context) {
    context.numberOfOuterEnvironments += 1
    const environment = createBlockEnvironment(context, 'programEnvironment')
    pushEnvironment(context, environment)
    return yield* evaluateBlockSatement(context, node)
  }
}
// tslint:enable:object-literal-shorthand

export function* evaluate(node: es.Node, context: Context) {
  const result = yield* evaluators[node.type](node, context)
  return result
}

export function* apply(
  context: Context,
  fun: Closure | Value,
  args: Value[],
  node: es.CallExpression,
  thisContext?: Value
) {
  if (fun instanceof Closure) {
    checkNumberOfArguments(context, fun, args, node!)
    const environment = createEnvironment(fun, args, node)
    environment.thisContext = thisContext
    pushEnvironment(context, environment)
    const applicationValueGenerator = evaluateBlockSatement(
      context,
      cloneDeep(fun.node.body) as es.BlockStatement
    )

    // This function takes a value that may be a ReturnValue.
    // If so, it returns the value wrapped in the ReturnValue.
    // If not, it returns the default value.
    function unwrapReturnValue(result: any, defaultValue: any) {
      if (result instanceof ReturnValue) {
        return result.value
      } else {
        return defaultValue
      }
    }

    for (const applicationValue of applicationValueGenerator) {
      popEnvironment(context)
      yield unwrapReturnValue(applicationValue, undefined)
      pushEnvironment(context, environment)
    }
  } else if (typeof fun === 'function') {
    try {
      yield fun.apply(thisContext, args)
    } catch (e) {
      // Recover from exception
      context.runtime.environments = context.runtime.environments.slice(
        -context.numberOfOuterEnvironments
      )

      const loc = node ? node.loc! : constants.UNKNOWN_LOCATION
      if (!(e instanceof RuntimeSourceError || e instanceof errors.ExceptionError)) {
        // The error could've arisen when the builtin called a source function which errored.
        // If the cause was a source error, we don't want to include the error.
        // However if the error came from the builtin itself, we need to handle it.
        return handleRuntimeError(context, new errors.ExceptionError(e, loc))
      }
      throw e
    }
  } else {
    return handleRuntimeError(context, new errors.CallingNonFunctionValue(fun, node))
  }

  popEnvironment(context)
  return
}

export { evaluate as nonDetEvaluate }
