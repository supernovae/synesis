#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { SynesisYarnAcpAgent } from "./synesis-yarn-acp-agent.js";
const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = ndJsonStream(input, output);
new AgentSideConnection((conn) => new SynesisYarnAcpAgent(conn), stream);
