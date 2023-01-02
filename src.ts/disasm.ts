import { ethers } from "ethers";

import { ABI, ABIFunction, ABIEvent, StateMutability } from "./abi";

type OpCode = number;

// Some opcodes we care about, doesn't need to be a complete list
const opcodes: Readonly<{ [key: string]: OpCode }> = Object.freeze({
    STOP: 0x00,
    EQ: 0x14,
    ISZERO: 0x15,
    CALLVALUE: 0x34,
    CALLDATALOAD: 0x35,
    CALLDATASIZE: 0x36,
    SLOAD: 0x54,
    SSTORE: 0x55,
    JUMP: 0x56,
    JUMPI: 0x57,
    JUMPDEST: 0x5b,
    PUSH1: 0x60,
    PUSH4: 0x63,
    PUSH32: 0x7f,
    DUP1: 0x80,
    LOG1: 0xa1,
    LOG4: 0xa4,
    RETURN: 0xf3,
});

// Return PUSHN width of N if PUSH instruction, otherwise 0
export function pushWidth(instruction: OpCode): number {
    if (instruction < opcodes.PUSH1 || instruction > opcodes.PUSH32) return 0;
    return instruction - opcodes.PUSH1 + 1;
}

export function isPush(instruction: OpCode): boolean {
    return !(instruction < opcodes.PUSH1 || instruction > opcodes.PUSH32);
}

export function isLog(instruction: OpCode): boolean {
    return instruction >= opcodes.LOG1 && instruction <= opcodes.LOG4;
}

function valueToOffset(value: Uint8Array): number {
    // FIXME: Should be a cleaner way to do this...
    return parseInt(ethers.utils.hexlify(value), 16);
}

// BytecodeIter takes EVM bytecode and handles iterating over it with correct
// step widths, while tracking N buffer of previous offsets for indexed access.
// This is useful for checking against sequences of variable width
// instructions.
export class BytecodeIter {
    bytecode: Uint8Array;

    nextStep: number; // Instruction count
    nextPos: number; // Byte-wise instruction position (takes variable width into account)

    // TODO: Could improve the buffer by making it sparse tracking of only
    // variable-width (PUSH) instruction indices, this would allow relatively
    // efficient seeking to arbitrary positions after a full iter. Then again,
    // roughly 1/4 of instructions are PUSH, so maybe it doesn't help enough?

    posBuffer: number[]; // Buffer of positions
    posBufferSize: number;

    constructor(bytecode: string, config?: { bufferSize?: number }) {
        this.nextStep = 0;
        this.nextPos = 0;
        if (config === undefined) config = {};

        this.posBufferSize = Math.max(config.bufferSize || 1, 1);
        this.posBuffer = [];

        this.bytecode = ethers.utils.arrayify(bytecode, { allowMissingPrefix: true });
    }

    hasMore(): boolean {
        return (this.bytecode.length > this.nextPos);
    }

    next(): OpCode {
        if (this.bytecode.length <= this.nextPos) return opcodes.STOP;

        const instruction = this.bytecode[this.nextPos];
        const width = pushWidth(instruction);

        // TODO: Optimization: Could use a circular buffer
        if (this.posBuffer.length >= this.posBufferSize) this.posBuffer.shift();
        this.posBuffer.push(this.nextPos);

        this.nextStep += 1;
        this.nextPos += 1 + width;

        return instruction;
    }

    // step is the current instruction position that we've iterated over. If
    // iteration has not begun, then it's -1.
    step(): number {
        return this.nextStep - 1;
    }

    // pos is the byte offset of the current instruction we've iterated over.
    // If iteration has not begun then it's -1.
    pos(): number {
        if (this.posBuffer.length === 0) return -1;
        return this.posBuffer[this.posBuffer.length - 1];
    }

    // at returns instruction at an absolute byte position or relative negative
    // buffered step offset. Buffered step offsets must be negative and start
    // at -1 (current step).
    at(posOrRelativeStep: number): OpCode {
        let pos = posOrRelativeStep;
        if (pos < 0) {
            pos = this.posBuffer[this.posBuffer.length + pos];
            if (pos === undefined) {
                throw new Error("buffer does not contain relative step");
            }
        }
        return this.bytecode[pos];
    }

    // value of last next-returned OpCode (should be a PUSHN intruction)
    value(): Uint8Array {
        return this.valueAt(-1);
    }

    // valueAt returns the variable width value for PUSH-like instructions (or
    // empty value otherwise), at pos pos can be a relative negative count for
    // relative buffered offset.
    valueAt(posOrRelativeStep: number): Uint8Array {
        let pos = posOrRelativeStep;
        if (pos < 0) {
            pos = this.posBuffer[this.posBuffer.length + pos];
            if (pos === undefined) {
                throw new Error("buffer does not contain relative step");
            }
        }
        const instruction = this.bytecode[pos];
        const width = pushWidth(instruction);
        return this.bytecode.slice(pos + 1, pos + 1 + width);
    }
}

// Opcodes that tell us something interesting about the function they're in
const interestingOpCodes : Set<OpCode> = new Set([
    opcodes.STOP, // No return value
    opcodes.RETURN, // Has return value?
    opcodes.CALLDATALOAD, // Has arguments
    opcodes.CALLDATASIZE, // FIXME: Is it superfluous to have these two?
    opcodes.CALLDATACOPY,
    opcodes.SLOAD, // Not pure
    opcodes.SSTORE, // Not view
    // TODO: Add LOGs to track event emitters?
]);

type Function = {
    byteOffset: number // JUMPDEST byte offset
    opTags: Set<OpCode>; // Track whether function uses interesting opcodes
    start: number; // JUMPDEST instruction offset
    jumps: Array<number>; // JUMPDEST instruction offsets this function can jump to
    end?: number; // Last instruction offset before the next JUMPDEST
};

type Program = {
    dests: { [key: number]: Function }; // instruction offset -> Function
    jumps: { [key: string]: number }; // function hash -> instruction offset
    notPayable: { [key: number]: number }; // instruction offset -> bytes offset
    eventCandidates: Array<string>; // PUSH32 found before a LOG instruction
}

export function abiFromBytecode(bytecode: string): ABI {
    const p = disasm(bytecode);

    const abi: ABI = [];
    for (const [selector, offset] of Object.entries(p.jumps)) {
        // TODO: Optimization: If we only look at selectors in the jump table region, we shouldn't need to check JUMPDEST validity.
        if (!(offset in p.dests)) {
            // Selector does not point to a valid jumpdest. This should not happen.
            continue;
        }

        // Collapse tags for function call graph
        const fn = p.dests[offset];
        const tags = collapseTags(fn, p.dests);

        const funcABI = {
            type: "function",
            selector: selector,
            payable: !p.notPayable[p.jumps[selector]],
        } as ABIFunction;

        // Unfortunately we don't have better details about the type sizes, so we just return a dynamically-sized /shrug
        if (tags.has(opcodes.RETURN)) {
            funcABI.outputs = [{type: "bytes"}];
        }
        if (tags.has(opcodes.CALLDATALOAD) || tags.has(opcodes.CALLDATASIZE) || tags.has(opcodes.CALLDATACOPY)) {
            funcABI.inputs = [{type: "bytes"}];
        }

        let mutability : StateMutability = "nonpayable";
        if (funcABI.payable) {
            mutability = "payable";
        } else if (!tags.has(opcodes.SSTORE)) {
            mutability = "view";
        }
        // TODO: Can we make a claim about purity? Probably not reliably without handling dynamic jumps?
        // if (mutability === "view" && !tags.has(opcodes.SLOAD)) {
        //    mutability = "pure";
        // }

        funcABI.stateMutability = mutability;

        abi.push(funcABI);
    }

    for (const h of p.eventCandidates) {
        abi.push({
            type: "event",
            hash: h,
        } as ABIEvent);
    }

    return abi;
}

const _EmptyArray = new Uint8Array();

function disasm(bytecode: string): Program {
    const p = {
        dests: {},
        jumps: {},
        notPayable: {},
        eventCandidates: [],
    } as Program;

    const selectorDests = new Set<number>();

    let lastPush32: Uint8Array = _EmptyArray;  // Track last push32 to find log topics
    let currentFunction: Function = {} as Function;
    let inJumpTable: boolean = true;

    let maxOffset = bytecode.length / 2; // FIXME: Rough upper-bound for max addressable instruction, should load it more precisely. We use this to guess if a PUSH refers to a dynamic JUMPDEST instruction.
    let maxOffsetLength = ethers.utils.arrayify(ethers.utils.hexlify(maxOffset)).length;
    let minOffset = 0;

    const code = new BytecodeIter(bytecode, { bufferSize: 4 });

    while (code.hasMore()) {
        const inst = code.next();
        const pos = code.pos();
        const step = code.step();

        // Track last PUSH32 to find LOG topics
        // This is probably not bullet proof but seems like a good starting point
        if (inst === opcodes.PUSH32) {
            lastPush32 = code.value();
            continue
        } else if (isLog(inst) && lastPush32.length > 0) {
            p.eventCandidates.push(ethers.utils.hexlify(lastPush32));
            continue
        }

        // Find JUMPDEST labels
        if (inst === opcodes.JUMPDEST) {
            // Index jump destinations so we can check against them later
            if (currentFunction) currentFunction.end = pos - 1;
            currentFunction = {
                byteOffset: step,
                start: pos,
                opTags: new Set(),
                jumps: new Array<number>(),
            } as Function;
            p.dests[pos] = currentFunction;

            // Check whether a JUMPDEST has non-payable guards
            //
            // We look for a sequence of instructions that look like:
            // JUMPDEST CALLVALUE DUP1 ISZERO
            //
            // We can do direct positive indexing because we know that there
            // are no variable-width instructions in our sequence.
            if (
                code.at(pos + 1) === opcodes.CALLVALUE &&
                code.at(pos + 2) === opcodes.DUP1 &&
                code.at(pos + 3) === opcodes.ISZERO
            ) {
                p.notPayable[pos] = step;
                // TODO: Optimization: Could seek ahead 3 pos/count safely
            }

            // TODO: Check whether function has a simple return flow?
            // if (code.at(pos - 1) === opcodes.RETURN) { ... }

            // Check whether we've reached the end of the selector jump table,
            // first time we see: JUMPDEST CALLDATASIZE
            if (inJumpTable && code.at(pos + 1) === opcodes.CALLDATASIZE) {
                inJumpTable = false;
                minOffset = step + 1;
            }

            continue;
        }

        // Annotate current function
        if (currentFunction.opTags !== undefined) {

            // Detect simple JUMP/JUMPI helper subroutines
            if ((inst === opcodes.JUMP || inst === opcodes.JUMPI) && isPush(code.at(-2))) {
                const jumpOffset = valueToOffset(code.valueAt(-2));
                currentFunction.jumps.push(jumpOffset);
            }

            // Tag current function with interesting opcodes (not including above)
            if (interestingOpCodes.has(inst)) {
                currentFunction.opTags.add(inst);
            }
        }

        if (!inJumpTable) {
            if (isPush(inst)) {
                // Is it a dynamic jump candidate?
                // It's fairly slow to test extraneous jumps, so we try to eliminate any extreme outliers early.
                const val = code.value();
                if (val.length > maxOffsetLength) continue;
                const maybeOffset: number = valueToOffset(code.value());
                if (maybeOffset < minOffset) continue;
                if (maybeOffset > maxOffset) continue;

                // We'll need to double-check later that this jump is a valid JUMPDEST
                console.log("Adding maybe offset:", maybeOffset);
                currentFunction.jumps.push(maybeOffset);
            }

            continue; // Skip searching for function selectors at this point
        }

        // Find callable function selectors:
        //
        // https://github.com/ethereum/solidity/blob/242096695fd3e08cc3ca3f0a7d2e06d09b5277bf/libsolidity/codegen/ContractCompiler.cpp#L333
        //
        // We're looking for a sequence of opcodes that looks like:
        //
        //    DUP1 PUSH4 0x2E64CEC1 EQ PUSH1 0x37    JUMPI
        //    DUP1 PUSH4 <BYTE4>    EQ PUSHN <BYTEN> JUMPI
        //    80   63    ^          14 60-7f ^       57
        //               Selector            Dest
        //
        // We can reliably skip checking for DUP1 if we're only searching
        // within `inJumpTable` range.
        //
        // Note that sizes of selectors and destinations can vary. Selector
        // PUSH can get optimized with zero-prefixes, all the way down to an
        // ISZERO routine (see next condition block).
        if (
            code.at(-1) === opcodes.JUMPI &&
            isPush(code.at(-2)) &&
            code.at(-3) === opcodes.EQ &&
            isPush(code.at(-4))
        ) {
            // Found a function selector sequence, save it to check against JUMPDEST table later
            let value = code.valueAt(-4)
            if (value.length < 4) {
                // 0-prefixed comparisons get optimized to a smaller width than PUSH4
                value = ethers.utils.zeroPad(value, 4);
            }
            const selector: string = ethers.utils.hexlify(value);
            const offsetDest: number = valueToOffset(code.valueAt(-2));
            p.jumps[selector] = offsetDest;
            selectorDests.add(offsetDest);

            continue;
        }
        // In some cases, the sequence can get optimized such as for 0x00000000:
        //    DUP1 ISZERO PUSHN <BYTEN> JUMPI
        if (
            code.at(-1) === opcodes.JUMPI &&
            isPush(code.at(-2)) &&
            code.at(-3) === opcodes.ISZERO
        ) {
            const selector = "0x00000000";
            const offsetDest: number = valueToOffset(code.valueAt(-2));
            p.jumps[selector] = offsetDest;
            selectorDests.add(offsetDest);

            continue;
        }
    }

    return p;
}

function collapseTags(fn: Function, dests: { [key: number]: Function }): Set<OpCode> {
    let tags = fn.opTags;
    for (const jumpOffset of fn.jumps) {
        // TODO: Probably want un-recurse this
        // XXX: How do we avoid circular graphs here?
        if (dests[jumpOffset] === undefined) continue; // Invalid jump
        const moreTags = collapseTags(dests[jumpOffset], dests);
        tags = new Set([...tags, ...moreTags]);
    }
    return tags;
}


// Debug helper:

export function programToDotGraph(p: Program): string {
    const nameLookup = Object.fromEntries(Object.entries(p.jumps).map(([k, v]) => [v, "SEL" + k]));
    const start = {start: 0, jumps: Object.values(p.jumps)} as Function;

    function jumpsToDot(fn: Function): string {
        if (fn.jumps.length === 0) return "";

        function name(n: number): string {
            return nameLookup[n] || ("FUNC" + n);
        }

        let s = name(fn.start) + " -> { " + fn.jumps.map(n => name(n)).join(" ") + " }\n";
        for (const jump of fn.jumps) {
            s += jumpsToDot(p.dests[jump]);
        }
        return s;
    }

    return "digraph jumps {\n" + jumpsToDot(start) + "\n}";
}

