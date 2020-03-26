import {
    API,
    FileInfo,
    Decorator,
    ASTPath,
    ClassProperty,
    Node,
    ClassDeclaration,
    MethodDefinition,
    ClassMethod,
    CallExpression,
    Identifier,
    FunctionExpression,
    ArrowFunctionExpression
} from "jscodeshift"

const validDecorators = ["action", "observable", "computed"]

const babylon = require("@babel/parser")

const defaultOptions = {
    sourceType: "module",
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    startLine: 1,
    tokens: true,
    plugins: [
        // "estree",
        "asyncGenerators",
        "bigInt",
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        ["decorators", { decoratorsBeforeExport: true }],
        "legacy-decorators",
        "doExpressions",
        "dynamicImport",
        "exportDefaultFrom",
        "exportNamespaceFrom",
        "functionBind",
        "functionSent",
        "importMeta",
        "logicalAssignment",
        "nullishCoalescingOperator",
        "numericSeparator",
        "objectRestSpread",
        "optionalCatchBinding",
        "optionalChaining",
        ["pipelineOperator", { proposal: "minimal" }],
        "throwExpressions",
        "typescript"
    ]
}

export const parser = {
    parse(code) {
        return babylon.parse(code, defaultOptions)
    }
}

export default function tranform(
    fileInfo: FileInfo,
    api: API,
    options?: { ignoreImports: boolean }
): any {
    const j = api.jscodeshift
    const superCall = j.expressionStatement(j.callExpression(j.super(), []))
    const initializeObservablesCall = j.expressionStatement(
        j.callExpression(j.identifier("initializeObservables"), [j.thisExpression()])
    )
    const source = j(fileInfo.source)
    const lines = fileInfo.source.split("\n")
    let changed = false
    let needsInitializeImport = false
    const decoratorsUsed = new Set<String>(options?.ignoreImports ? validDecorators : [])
    let usesDecorate = options?.ignoreImports ? true : false

    source.find(j.ImportDeclaration).forEach(im => {
        if (im.value.source.value === "mobx") {
            let decorateIndex = -1
            im.value.specifiers.forEach((specifier, idx) => {
                // imported decorator
                if (
                    j.ImportSpecifier.check(specifier) &&
                    validDecorators.includes(specifier.imported.name)
                ) {
                    decoratorsUsed.add(specifier.imported.name)
                }
                // imported decorate call
                if (j.ImportSpecifier.check(specifier) && specifier.imported.name === "decorate") {
                    usesDecorate = true
                    decorateIndex = idx
                }
            })
            if (decorateIndex !== -1) {
                im.value.specifiers.splice(decorateIndex, 1)
            }
        }
    })

    // rewrite all decorate calls to class decorators
    if (usesDecorate) {
        source
            .find(j.CallExpression)
            .filter(
                callPath =>
                    j.Identifier.check(callPath.value.callee) &&
                    callPath.value.callee.name === "decorate"
            )
            .forEach(callPath => {
                let canRemoveDecorateCall = true
                if (callPath.value.arguments.length !== 2) {
                    warn("Expected a decorate call with two arguments", callPath.value)
                    return
                }
                const target = callPath.value.arguments[0]
                const decorators = callPath.value.arguments[1]
                if (!j.Identifier.check(target)) {
                    warn("Expected an identifier as first argument to decorate", target)
                    return
                }
                if (!j.ObjectExpression.check(decorators)) {
                    warn("Expected a plain object as second argument to decorate", decorators)
                    return
                }
                // Find that class
                let declarations = source
                    .find(j.ClassDeclaration)
                    .filter(
                        declPath =>
                            j.Identifier.check(declPath.value.id) &&
                            declPath.value.id.name === target.name
                    )
                if (declarations.nodes().length === 0) {
                    warn(
                        `Expected exactly one class declaration for '${target.name}' but found ${declarations.length}`,
                        target
                    )
                    return
                }
                // if there are multiple declarations, find the one that seems the closest
                const bestDeclarations = declarations.filter(
                    dec => dec.parent.value === callPath.parent.parent.value
                )
                const clazz: ClassDeclaration = bestDeclarations.length
                    ? bestDeclarations.nodes()[0]
                    : declarations.nodes()[0]

                let insertedMemberOffset = 0
                // Iterate the properties
                decorators.properties.forEach(prop => {
                    if (
                        !j.ObjectProperty.check(prop) ||
                        // @ts-ignore
                        prop.method ||
                        prop.shorthand ||
                        prop.computed ||
                        !j.Identifier.check(prop.key)
                    ) {
                        warn("Expected plain property definition", prop)
                        canRemoveDecorateCall = false
                        return
                    }
                    if (j.ArrayExpression.check(prop.value)) {
                        warn("Cannot undecorate composed decorators", prop.value)
                        canRemoveDecorateCall = false
                        return
                    }
                    const name = prop.key.name
                    let propDeclaration = clazz.body.body.filter(
                        member =>
                            (j.ClassProperty.check(member) || j.ClassMethod.check(member)) &&
                            j.Identifier.check(member.key) &&
                            member.key.name === name
                    )[0]
                    if (!propDeclaration) {
                        // for observables that are not declared yet, create new members
                        if (
                            (j.Identifier.check(prop.value) && prop.value.name === "observable") ||
                            (j.MemberExpression.check(prop.value) &&
                                j.Identifier.check(prop.value.object) &&
                                prop.value.object.name === "observable")
                        ) {
                            clazz.body.body.splice(
                                insertedMemberOffset++,
                                0,
                                // TODO: ideally we'd find private / public modifiers in the constructor arguments
                                // and copy them over
                                (propDeclaration = j.classProperty(prop.key, null))
                            )
                        } else {
                            canRemoveDecorateCall = false
                            warn(`Failed to find member '${name}' in class '${target.name}'`, prop)
                            return
                        }
                    }
                    // @ts-ignore
                    // rewrite it as decorator, since that is rewritten anyway in the next step :)
                    propDeclaration.decorators = [j.decorator(prop.value)]
                })
                // Remove the callPath (and wrapping expressionStatement)
                if (canRemoveDecorateCall) {
                    callPath.parent.prune()
                }
                changed = true
            })
    }

    // rewrite all class decorators
    source.find(j.ClassDeclaration).forEach(clazzPath => {
        const clazz = clazzPath.value
        const effects = {
            needsConstructor: false,
            membersToRemove: [] as any[]
        }

        clazz.body.body = clazz.body.body
            .map(prop => {
                if (j.ClassProperty.check(prop) || j.ClassMethod.check(prop)) {
                    return handleProperty(prop as any, effects, clazzPath)
                }
                return prop
            })
            .filter(Boolean)
            .filter(elem => !effects.membersToRemove.includes(elem))

        if (effects.needsConstructor) {
            createConstructor(clazz)
            needsInitializeImport = true
        }
    })
    if (needsInitializeImport) {
        // @ts-ignore
        const mobxImport = source
            .find(j.ImportDeclaration)
            .filter(im => im.value.source.value === "mobx")
            .nodes()[0]
        if (!mobxImport) {
            console.warn(
                "Failed to find mobx import, can't add initializeObservables as dependency in " +
                    fileInfo.path
            )
        } else {
            if (!mobxImport.specifiers) {
                mobxImport.specifiers = []
            }
            mobxImport.specifiers.push(j.importSpecifier(j.identifier("initializeObservables")))
        }
    }
    if (!decoratorsUsed.size && !usesDecorate) {
        return // no mobx in this file
    }
    if (changed) {
        return source.toSource()
    }

    function handleProperty(
        property: ClassProperty /* | or ClassMethod */ & { decorators: Decorator[] },
        effects: {
            needsConstructor: boolean
            membersToRemove: any[]
        },
        clazzPath: ASTPath<ClassDeclaration>
    ): ClassProperty | ClassMethod {
        const decorators = property.decorators
        if (!decorators || decorators.length === 0) {
            return property
        }
        if (decorators.length > 1) {
            warn("Found multiple decorators, skipping..", property.decorators[0])
            return property
        }
        const decorator = decorators[0]
        if (!j.Decorator.check(decorator)) {
            return property
        }
        const expr = decorator.expression
        if (j.Identifier.check(expr) && !decoratorsUsed.has(expr.name)) {
            warn(`Found non-mobx decorator @${expr.name}`, decorator)
            return property
        }
        if (property.static) {
            warn(`Static properties are not supported ${property.key.loc?.source}`, property)
            return property
        }

        const propInfo = parseProperty(property, clazzPath)
        // console.dir(propInfo)
        property.decorators.splice(0)

        // ACTIONS
        if (propInfo.baseDecorator === "action") {
            changed = true
            // those return false, since for actions we don't need to run initializeObservables again
            switch (true) {
                //@action.bound("x") = y
                //@action.bound = y
                case propInfo.type === "field" && propInfo.subDecorator === "bound": {
                    const arrowFn = toArrowFn(property.value as any)
                    property.value = fnCall(
                        // special case: if it was a generator function, it will still be a function expression, so still requires bound
                        ["action", j.FunctionExpression.check(arrowFn) && "bound"],
                        [propInfo.callArg, arrowFn]
                    )
                    return property
                }
                //@action.bound("x") m()
                //@action.bound m()
                case propInfo.type === "method" && propInfo.subDecorator === "bound": {
                    const arrowFn = toArrowFn(propInfo.expr as any)
                    const res = j.classProperty(
                        property.key,
                        fnCall(
                            // special case: if it was a generator function, it will still be a function expression, so still requires bound
                            ["action", j.FunctionExpression.check(arrowFn) && "bound"],
                            [propInfo.callArg, arrowFn]
                        )
                    )
                    res.comments = property.comments
                    return res
                }
                //@action("x") = y
                //@action x = y
                case propInfo.type === "field" && !propInfo.subDecorator:
                    property.value = fnCall(["action"], [propInfo.callArg, property.value])
                    return property
                // //@action("x") m()
                // //@action m()
                case propInfo.type === "method": {
                    generateActionInitializationOnPrototype(clazzPath, property, propInfo)
                    return property
                }
                default:
                    warn("Uknown case for undecorate action ", property)
                    return property
            }
        }

        // OBSERVABLE
        if (propInfo.baseDecorator === "observable") {
            //@observable f = y
            //@observable.x f = y
            //@observable ['x'] = y
            changed = true
            effects.needsConstructor = true
            property.value = fnCall(["observable", propInfo.subDecorator], [property.value])
            return property
        }

        // COMPUTED
        if (propInfo.baseDecorator === "computed") {
            //@computed get m() // rewrite to this!
            //@computed get m() set m()
            //@computed(options) get m()
            //@computed(options) get m() set m()
            //@computed.struct get m()
            //@computed.struct get m() set m()
            changed = true
            effects.needsConstructor = true
            const res = j.classProperty(
                property.key,
                fnCall(
                    ["computed", propInfo.subDecorator],
                    [
                        toArrowFn(propInfo.expr),
                        propInfo.setterExpr ? toArrowFn(propInfo.setterExpr) : undefined,
                        propInfo.callArg
                    ]
                )
            )
            res.comments = property.comments
            if (propInfo.setterExpr) effects.membersToRemove.push(propInfo.setterExpr)
            return res
        }
        return property
    }

    function generateActionInitializationOnPrototype(
        clazzPath: ASTPath<ClassDeclaration>,
        property: ClassProperty,
        propInfo: ReturnType<typeof parseProperty>
    ) {
        // N.B. this is not a transformation that one would write manually,
        // e.g. m = action(fn) would be way more straight forward,
        // but this transformation better preserves the old semantics, like sharing the action
        // on the prototype, which saves a lot of memory allocations, which some existing apps
        // might depend upon
        const clazzId = clazzPath.value.id
        const isComputedName = !j.Identifier.check(property.key)
        if (!clazzId) {
            warn(`Cannot transform action of anonymous class`, property)
        } else {
            // Bla.prototype.x = action(Bla.prototype.x)
            clazzPath.insertAfter(
                j.expressionStatement(
                    j.assignmentExpression(
                        "=",
                        j.memberExpression(
                            j.memberExpression(clazzId, j.identifier("prototype")),
                            property.key,
                            isComputedName
                        ),
                        fnCall(
                            ["action"],
                            [
                                propInfo.callArg,
                                j.memberExpression(
                                    j.memberExpression(clazzId, j.identifier("prototype")),
                                    property.key,
                                    isComputedName
                                )
                            ]
                        )
                    )
                )
            )
        }
    }

    function parseProperty(
        p: (ClassProperty | MethodDefinition) & { decorators: Decorator[] },
        clazzPath: ASTPath<ClassDeclaration>
    ): {
        isCallExpression: boolean // TODO: not used?
        baseDecorator: "action" | "observable" | "computed"
        subDecorator: string
        type: "field" | "method" | "getter"
        expr: any
        callArg: any
        setterExpr: any
    } {
        const decExpr = p.decorators[0].expression
        const isCallExpression = j.CallExpression.check(decExpr)
        let baseDecorator = ""
        let subDecorator = ""
        let callArg: any
        // console.dir(decExpr)
        if (isCallExpression && j.MemberExpression.check((decExpr as CallExpression).callee)) {
            const me = (decExpr as CallExpression).callee
            if (
                j.MemberExpression.check(me) &&
                j.Identifier.check(me.object) &&
                j.Identifier.check(me.property)
            ) {
                baseDecorator = me.object.name
                subDecorator = me.property.name
            } else {
                warn(`Decorator expression too complex, please convert manually`, decExpr)
            }
        } else if (isCallExpression && j.Identifier.check((decExpr as CallExpression).callee)) {
            baseDecorator = ((decExpr as CallExpression).callee as Identifier).name
        } else if (
            j.MemberExpression.check(decExpr) &&
            j.Identifier.check(decExpr.object) &&
            j.Identifier.check(decExpr.property)
        ) {
            baseDecorator = decExpr.object.name
            subDecorator = decExpr.property.name
        } else if (j.Identifier.check(decExpr)) {
            baseDecorator = decExpr.name
        } else {
            warn(`Decorator expression too complex, please convert manually`, decExpr)
        }

        if (isCallExpression && (decExpr as CallExpression).arguments.length !== 1) {
            warn(`Expected exactly one argument`, decExpr)
        }
        callArg = isCallExpression && (decExpr as CallExpression).arguments[0]

        const setterExpr = clazzPath.value.body.body.find(
            m =>
                j.ClassMethod.check(m) &&
                m.kind === "set" &&
                j.Identifier.check(m.key) &&
                j.Identifier.check(p.key) &&
                m.key.name === p.key.name
        )

        return {
            isCallExpression,
            baseDecorator: baseDecorator as any,
            subDecorator,
            type: j.ClassMethod.check(p) ? (p.kind === "get" ? "getter" : "method") : "field",
            expr: j.ClassMethod.check(p) ? p : p.value,
            callArg,
            setterExpr
        }
    }

    function createConstructor(clazz: ClassDeclaration) {
        const needsSuper = !!clazz.superClass
        let constructorIndex = clazz.body.body.findIndex(
            member => j.ClassMethod.check(member) && member.kind === "constructor"
        )
        // create a constructor
        if (constructorIndex === -1) {
            if (needsSuper) {
                warn(
                    `Generated new constructor for class ${clazz.id?.name}. But since the class does have a base class, it might be needed to revisit the arguments that are passed to \`super()\``,
                    clazz
                )
            }
            const constructorDecl = j.methodDefinition(
                "constructor",
                j.identifier("constructor"),
                j.functionExpression(
                    null,
                    [],
                    j.blockStatement(
                        needsSuper
                            ? [superCall, initializeObservablesCall]
                            : [initializeObservablesCall]
                    )
                )
            )

            const firstMethodIndex = clazz.body.body.findIndex(member =>
                j.ClassMethod.check(member)
            )
            if (firstMethodIndex === -1) {
                clazz.body.body.push(constructorDecl)
            } else {
                clazz.body.body.splice(firstMethodIndex, 0, constructorDecl)
            }
        } else {
            const c: ClassMethod = clazz.body.body[constructorIndex] as any
            j.ClassMethod.assert(c)
            const firstStatement = c.body.body[0]
            const hasSuper =
                firstStatement &&
                j.ExpressionStatement.check(firstStatement) &&
                j.CallExpression.check(firstStatement.expression) &&
                j.Super.check(firstStatement.expression.callee)
            c.body.body.splice(hasSuper ? 1 : 0, 0, initializeObservablesCall)
        }
    }

    function fnCall(name: [string] | [string, string | false], args: any[]) {
        return j.callExpression(
            name.filter(Boolean).length === 2
                ? j.memberExpression(j.identifier(name[0]), j.identifier(name[1] as any))
                : j.identifier(name[0]),
            args.filter(Boolean)
        )
    }

    function toArrowFn(m: ClassMethod): FunctionExpression | ArrowFunctionExpression {
        if (j.ArrowFunctionExpression.check(m) || !j.ClassMethod.check(m)) {
            // leave arrow funcs (and everything not a method at all) alone
            return m
        }
        const res = m.generator
            ? j.functionExpression(null, m.params, m.body, true)
            : j.arrowFunctionExpression(m.params, m.body)
        res.returnType = m.returnType
        // res.comments = m.comments
        res.async = m.async
        return res
    }

    function warn(msg: string, node: Node) {
        const line = lines[node.loc!.start.line - 1]
        const shortline = line.replace(/^\s*/, "")
        console.warn(
            `[mobx:undecorate] ${msg} at (${fileInfo.path}:${node.loc!.start.line}:${
                node.loc!.start.column
            }):\n\t${shortline}\n\t${"^".padStart(
                node.loc!.start.column + 1 - line.indexOf(shortline),
                " "
            )}\n`
        )
    }
}