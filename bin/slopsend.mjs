#!/usr/bin/env node
import { main } from '../src/slopsend.mjs';

await main(process.argv.slice(2));
