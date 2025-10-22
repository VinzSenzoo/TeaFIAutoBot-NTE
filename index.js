import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import axios from "axios";

const TEAFI_RPC_URL = "https://polygon-bor-rpc.publicnode.com";
const TEAFI_CHAIN_ID = 137;
const POL_ADDRESS = "0x0000000000000000000000000000000000000000";
const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDT_ADDRESS = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const ROUTER_ADDRESS = "0xEb6132FAF257e9EBCAed78055C5302D81eb948BE";
const QUOTE_API_URL = "https://api.tea-fi.com/lifi/quote";
const TRANSACTION_API_URL = "https://api.tea-fi.com/transaction";
const CHECKIN_STATUS_URL = "https://api.tea-fi.com/wallet/check-in/current";
const CHECKIN_URL = "https://api.tea-fi.com/wallet/check-in";
const CONFIG_FILE = "config.json";
const isDebug = false;

const swapDirections = [
  { from: "USDC", to: "USDT", tokenIn: USDC_ADDRESS, tokenOut: USDT_ADDRESS },
  { from: "USDT", to: "USDC", tokenIn: USDT_ADDRESS, tokenOut: USDC_ADDRESS }
];

let walletInfo = {
  address: "N/A",
  balancePOL: "0.0000",
  balanceUSDC: "0.0000",
  balanceUSDT: "0.0000",
  activeAccount: "N/A"
};
let transactionLogs = [];
let activityRunning = false;
let isCycleRunning = false;
let shouldStop = false;
let dailyActivityInterval = null;
let accounts = [];
let proxies = [];
let selectedWalletIndex = 0;
let loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let blinkCounter = 0;
let spinnerIndex = 0;
let nonceTracker = {};
let hasLoggedSleepInterrupt = false;
let isHeaderRendered = false;
let activeProcesses = 0;

let dailyActivityConfig = {
  swapRepetitions: 1,
  usdcSwapRange: { min: 1, max: 1.1 },
  usdtSwapRange: { min: 1, max: 1.4 },
  loopHours: 24
};

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 OPR/122.0.0.0 (Edition cdf)"
];

const Headers = {
  'accept': '*/*',
  'content-type': 'application/json',
  'origin': 'https://app.tea-fi.com',
  'referer': 'https://app.tea-fi.com/',
  'connection': 'keep-alive',
  'accept-encoding': 'gzip, deflate, br'
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const config = JSON.parse(data);
      dailyActivityConfig.swapRepetitions = Number(config.swapRepetitions) || 1;
      dailyActivityConfig.usdcSwapRange.min = Number(config.usdcSwapRange?.min) || 1;
      dailyActivityConfig.usdcSwapRange.max = Number(config.usdcSwapRange?.max) || 1.1;
      dailyActivityConfig.usdtSwapRange.min = Number(config.usdtSwapRange?.min) || 1;
      dailyActivityConfig.usdtSwapRange.max = Number(config.usdtSwapRange?.max) || 1.4;
      dailyActivityConfig.loopHours = Number(config.loopHours) || 24;
    } else {
      addLog("No config file found, using default settings.", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

async function makeApiCall(url, method, data, proxyUrl) {
  try {
    const headers = { ...Headers, 'user-agent': userAgents[Math.floor(Math.random() * userAgents.length)] };
    const agent = createAgent(proxyUrl);
    if (isDebug) {
      addLog(`Debug: Sending API request to ${url} with payload: ${JSON.stringify(data, null, 2)}`, "debug");
    }
    const response = await axios({ method, url, data, headers, httpsAgent: agent });
    if (isDebug) {
      addLog(`Debug: API response from ${url}: ${JSON.stringify(response.data, null, 2)}`, "debug");
    }
    return response.data;
  } catch (error) {
    addLog(`API call failed (${url}): ${error.message}`, "error");
    if (error.response) {
      addLog(`Debug: Error response: ${JSON.stringify(error.response.data, null, 2)}`, "debug");
    }
    throw error;
  }
}

process.on("unhandledRejection", (reason) => {
  addLog(`Unhandled Rejection: ${reason.message || reason}`, "error");
});

process.on("uncaughtException", (error) => {
  addLog(`Uncaught Exception: ${error.message}\n${error.stack}`, "error");
  process.exit(1);
});

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function addLog(message, type = "info") {
  if (type === "debug" && !isDebug) return;
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error":
      coloredMessage = chalk.redBright(message);
      break;
    case "success":
      coloredMessage = chalk.greenBright(message);
      break;
    case "warn":
      coloredMessage = chalk.magentaBright(message);
      break;
    case "wait":
      coloredMessage = chalk.yellowBright(message);
      break;
    case "info":
      coloredMessage = chalk.whiteBright(message);
      break;
    case "delay":
      coloredMessage = chalk.cyanBright(message);
      break;
    case "debug":
      coloredMessage = chalk.blueBright(message);
      break;
    default:
      coloredMessage = chalk.white(message);
  }
  const logMessage = `[${timestamp}] ${coloredMessage}`;
  transactionLogs.push(logMessage);
  updateLogs();
}

function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function clearTransactionLogs() {
  transactionLogs = [];
  logBox.setContent('');
  logBox.scrollTo(0);
  addLog("Transaction logs cleared.", "success");
}

function loadAccounts() {
  try {
    const data = fs.readFileSync("pk.txt", "utf8");
    accounts = data.split("\n").map(line => line.trim()).filter(line => line).map(privateKey => ({ privateKey }));
    if (accounts.length === 0) {
      throw new Error("No private keys found in pk.txt");
    }
    addLog(`Loaded ${accounts.length} accounts from pk.txt`, "success");
  } catch (error) {
    addLog(`Failed to load accounts: ${error.message}`, "error");
    accounts = [];
  }
}

function loadProxies() {
  try {
    if (fs.existsSync("proxy.txt")) {
      const data = fs.readFileSync("proxy.txt", "utf8");
      proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
      if (proxies.length === 0) throw new Error("No proxy found in proxy.txt");
      addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
    } else {
      addLog("No proxy.txt found, running without proxy.", "info");
    }
  } catch (error) {
    addLog(`Failed to load proxy: ${error.message}`, "info");
    proxies = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  } else {
    return new HttpsProxyAgent(proxyUrl);
  }
}

function getProvider(proxyUrl, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const agent = createAgent(proxyUrl);
      const fetchOptions = agent ? { agent } : {};
      const provider = new ethers.JsonRpcProvider(TEAFI_RPC_URL, { chainId: TEAFI_CHAIN_ID, name: "Polygon" }, { fetchOptions });
      return provider;
    } catch (error) {
      addLog(`Attempt ${attempt}/${maxRetries} failed to initialize provider: ${error.message}`, "error");
      if (attempt < maxRetries) sleep(1000);
    }
  }
  throw new Error(`Failed to initialize provider for chain ${TEAFI_CHAIN_ID}`);
}

async function sleep(ms) {
  if (shouldStop) {
    if (!hasLoggedSleepInterrupt) {
      addLog("Process stopped successfully.", "info");
      hasLoggedSleepInterrupt = true;
    }
    return;
  }
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, ms);
      const checkStop = setInterval(() => {
        if (shouldStop) {
          clearTimeout(timeout);
          clearInterval(checkStop);
          if (!hasLoggedSleepInterrupt) {
            addLog("Process interrupted.", "info");
            hasLoggedSleepInterrupt = true;
          }
          resolve();
        }
      }, 100);
    });
  } catch (error) {
    addLog(`Sleep error: ${error.message}`, "error");
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function updateWalletData() {
  const erc20Abi = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
  const walletDataPromises = accounts.map(async (account, i) => {
    try {
      const proxyUrl = proxies[i % proxies.length] || null;
      const provider = getProvider(proxyUrl);
      const wallet = new ethers.Wallet(account.privateKey, provider);

      const polBalance = await provider.getBalance(wallet.address);
      const formattedPOL = Number(ethers.formatEther(polBalance)).toFixed(4);

      const usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);
      const usdcBalance = await usdcContract.balanceOf(wallet.address);
      const formattedUSDC = Number(ethers.formatUnits(usdcBalance, 6)).toFixed(4);

      const usdtContract = new ethers.Contract(USDT_ADDRESS, erc20Abi, provider);
      const usdtBalance = await usdtContract.balanceOf(wallet.address);
      const formattedUSDT = Number(ethers.formatUnits(usdtBalance, 6)).toFixed(4);

      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${chalk.bold.magentaBright(getShortAddress(wallet.address))}    ${chalk.bold.cyanBright(formattedPOL.padEnd(6))}  ${chalk.bold.cyanBright(formattedUSDC.padEnd(6))}  ${chalk.bold.cyanBright(formattedUSDT.padEnd(6))}`;

      if (i === selectedWalletIndex) {
        walletInfo.address = wallet.address;
        walletInfo.activeAccount = `Account ${i + 1}`;
        walletInfo.balancePOL = formattedPOL;
        walletInfo.balanceUSDC = formattedUSDC;
        walletInfo.balanceUSDT = formattedUSDT;
      }
      return formattedEntry;
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return `${i === selectedWalletIndex ? "→ " : "  "}N/A 0.000000 0.000000 0.000000`;
    }
  });
  try {
    const walletData = await Promise.all(walletDataPromises);
    addLog("Wallet data updated.", "success");
    return walletData;
  } catch (error) {
    addLog(`Wallet data update failed: ${error.message}`, "error");
    return [];
  }
}

async function getNextNonce(provider, walletAddress) {
  if (shouldStop) {
    addLog("Nonce fetch stopped due to stop request.", "info");
    throw new Error("Process stopped");
  }
  if (!ethers.isAddress(walletAddress)) {
    addLog(`Invalid wallet address: ${walletAddress}`, "error");
    throw new Error("Invalid wallet address");
  }
  const nonceKey = `${TEAFI_CHAIN_ID}_${walletAddress}`;
  try {
    const pendingNonce = BigInt(await provider.getTransactionCount(walletAddress, "pending"));
    const lastUsedNonce = nonceTracker[nonceKey] || (pendingNonce - 1n);
    const nextNonce = pendingNonce > lastUsedNonce + 1n ? pendingNonce : lastUsedNonce + 1n;
    nonceTracker[nonceKey] = nextNonce;
    addLog(`Debug: Fetched nonce ${nextNonce} for ${getShortAddress(walletAddress)} on chain ${TEAFI_CHAIN_ID}`, "debug");
    return nextNonce;
  } catch (error) {
    addLog(`Failed to fetch nonce for ${getShortAddress(walletAddress)} on chain ${TEAFI_CHAIN_ID}: ${error.message}`, "error");
    throw error;
  }
}

async function getFeeParams(provider) {
  try {
    const feeData = await provider.getFeeData();
    let params = {};
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      params = {
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        type: 2
      };
    } else {
      params = {
        gasPrice: feeData.gasPrice || ethers.parseUnits("1", "gwei"),
        type: 0
      };
    }
    return params;
  } catch (error) {
    addLog(`Failed to get fee data: ${error.message}. Using default.`, "debug");
    return {
      gasPrice: ethers.parseUnits("1", "gwei"),
      type: 0
    };
  }
}

async function getSwapQuote(direction, amountIn, walletAddress, proxyUrl) {
  const params = {
    fromAddress: walletAddress,
    fromAmount: amountIn.toString(),
    fromChain: TEAFI_CHAIN_ID,
    fromToken: direction.tokenIn,
    toChain: TEAFI_CHAIN_ID,
    toToken: direction.tokenOut,
    slippage: 0.005,
    allowExchanges: 'okx',
    preferExchanges: 'okx',
    gasPaymentTokenAddress: '0x0000000000000000000000000000000000000000'
  };
  try {
    const headers = { ...Headers, 'user-agent': userAgents[Math.floor(Math.random() * userAgents.length)] };
    const quoteResponse = await axios.get(QUOTE_API_URL, { params, headers, httpsAgent: createAgent(proxyUrl) });
    return quoteResponse.data.lifiQuote;
  } catch (error) {
    addLog(`Failed to get swap quote: ${error.message}`, "error");
    throw error;
  }
}

async function checkAndApproveToken(wallet, tokenAddress, spender, amountIn, provider, feeParams) {
  const erc20Abi = ["function allowance(address owner, address spender) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"];
  const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  const allowance = await tokenContract.allowance(wallet.address, spender);
  if (allowance < amountIn) {
    addLog(`Approving Token Sent..`, "info");
    const nonce = await getNextNonce(provider, wallet.address);
    const approveTx = await tokenContract.approve(spender, ethers.MaxUint256, { ...feeParams, nonce });
    await approveTx.wait();
    addLog(`Approval successful: ${getShortHash(approveTx.hash)}`, "success");
    return true;
  }
  return false;
}

const routerInterface = new ethers.Interface([
  "function makePublicSwap(bytes liFiSwapData, (bool, bool) synthSupport, bytes permitSingleSignature, bytes tokenSignature)"
]);

async function performSwap(wallet, direction, amount, proxyUrl) {
  const provider = getProvider(proxyUrl);
  wallet = wallet.connect(provider);

  const decimals = 6;
  const amountIn = ethers.parseUnits(amount.toString(), decimals);
  const address = wallet.address.toLowerCase();

  const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
  const tokenContract = new ethers.Contract(direction.tokenIn, erc20Abi, provider);
  const tokenBalance = await tokenContract.balanceOf(address);
  if (tokenBalance < amountIn) {
    throw new Error(`Insufficient ${direction.from} balance: ${ethers.formatUnits(tokenBalance, decimals)} < ${amount}`);
  }

  const quote = await getSwapQuote(direction, amountIn, address, proxyUrl);

  const liFiSwapData = quote.transactionRequest.data;
  const synthSupport = [false, false];
  const permitSingleSignature = "0x";
  const tokenSignature = "0x";

  const calldata = routerInterface.encodeFunctionData("makePublicSwap", [
    liFiSwapData,
    synthSupport,
    permitSingleSignature,
    tokenSignature
  ]);

  const feeParams = await getFeeParams(provider);

  if (direction.tokenIn !== POL_ADDRESS) {
    await checkAndApproveToken(wallet, direction.tokenIn, quote.estimate.approvalAddress, amountIn, provider, feeParams);
  }

  const txParams = {
    to: ROUTER_ADDRESS,
    data: calldata,
    value: 0n,
    ...feeParams,
    gasLimit: BigInt(quote.transactionRequest.gasLimit) 
  };

  const balance = await provider.getBalance(address);
  const estimatedGasCost = txParams.gasPrice ? txParams.gasPrice * txParams.gasLimit : txParams.maxFeePerGas * txParams.gasLimit;
  if (balance < estimatedGasCost) {
    throw new Error(`Insufficient POL balance for gas: ${ethers.formatEther(balance)} < ${ethers.formatEther(estimatedGasCost)}`);
  }

  const nonce = await getNextNonce(provider, address);

  let tx;
  try {
    tx = await wallet.sendTransaction({
      ...txParams,
      nonce
    });
    addLog(`Swap Transaction sent: ${getShortHash(tx.hash)}`, "warn");
  } catch (error) {
    addLog(`Transaction failed: ${error.message}`, "error");
    if (error.message.includes("nonce")) {
      const nonceKey = `${TEAFI_CHAIN_ID}_${address}`;
      delete nonceTracker[nonceKey];
      addLog(`Nonce error detected, resetting nonce for next attempt.`, "warn");
    }
    throw error;
  }

  let receipt;
  const timeoutMs = 120000;
  try {
    receipt = await monitorTransaction(provider, tx.hash, timeoutMs);
    if (!receipt || !receipt.hash) {
      throw new Error("Invalid transaction receipt");
    }
    if (receipt.status === 0) {
      throw new Error("Transaction reverted");
    }
    addLog(`Swap ${amount} ${direction.from} ➯ ${direction.to} Successfully, Hash:${getShortHash(tx.hash)} `, "success");
  } catch (error) {
    addLog(`Transaction failed: ${error.message}`, "error");
    throw error;
  }

  let effectiveGasPriceBigInt;
  if (receipt.effectiveGasPrice) {
    effectiveGasPriceBigInt = typeof receipt.effectiveGasPrice === 'bigint' ? receipt.effectiveGasPrice : BigInt(receipt.effectiveGasPrice);
  } else {
    effectiveGasPriceBigInt = txParams.gasPrice || txParams.maxFeePerGas;
  }
  const gasUsedBigInt = typeof receipt.gasUsed === 'bigint' ? receipt.gasUsed : BigInt(receipt.gasUsed);
  const gasFeeAmount = (gasUsedBigInt * effectiveGasPriceBigInt).toString();

  const postData = {
    hash: receipt.hash.toLowerCase(),
    blockchainId: TEAFI_CHAIN_ID,
    type: 0,
    walletAddress: address.toLowerCase(),
    fromTokenAddress: direction.tokenIn.toLowerCase(),
    toTokenAddress: direction.tokenOut.toLowerCase(),
    fromTokenSymbol: direction.from,
    toTokenSymbol: direction.to,
    fromAmount: amountIn.toString(),
    toAmount: quote.estimate.toAmount,
    gasFeeTokenAddress: '0x0000000000000000000000000000000000000000'.toLowerCase(),
    gasFeeTokenSymbol: 'POL',
    gasFeeAmount: gasFeeAmount
  };


  try {
    const postResponse = await axios.post(TRANSACTION_API_URL, postData, { headers: Headers, httpsAgent: createAgent(proxyUrl) });
    addLog(`Transaction reported successfully: Points ${postResponse.data.pointsAmount}`, "success");
  } catch (error) {
    addLog(`Failed to report transaction: ${error.message}`, "error");
    if (error.response) {
      addLog(`Transaction report error: ${JSON.stringify(error.response.data)}`, "error");
    }
  }
}

async function monitorTransaction(provider, txHash, timeoutMs) {
  const startTime = Date.now();
  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      throw new Error("Transaction confirmation timed out");
    }

    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt && receipt.blockNumber) {
      return receipt;
    }

    await sleep(5000);
  }
}

async function performCheckIn(walletAddress, proxyUrl) {
  try {
    addLog(`Checking check-in status for ${getShortAddress(walletAddress)}`, "info");
    const status = await makeApiCall(`${CHECKIN_STATUS_URL}?address=${walletAddress}`, 'get', null, proxyUrl);
    
    const lastCheckIn = status.lastCheckIn ? new Date(status.lastCheckIn) : null;
    const today = new Date();
    
    if (lastCheckIn) {
      const lastDateStr = lastCheckIn.toDateString();
      const todayDateStr = today.toDateString();
      
      if (lastDateStr === todayDateStr) {
        addLog(`Already checked in today for ${getShortAddress(walletAddress)}`, "info");
        return;
      }
    }
    
    addLog(`Performing daily check-in for ${getShortAddress(walletAddress)}`, "wait");
    const checkInResponse = await makeApiCall(`${CHECKIN_URL}?address=${walletAddress}`, 'post', {}, proxyUrl);
    addLog(`Check-in successful for ${getShortAddress(walletAddress)}: +${checkInResponse.points} points`, "success");
  } catch (error) {
    if (error.response && error.response.status === 400 && error.response.data.message === "Already checked in today") {
      addLog(`Already checked in today for ${getShortAddress(walletAddress)}`, "info");
    } else {
      addLog(`Check-in failed for ${getShortAddress(walletAddress)}: ${error.message}`, "error");
    }
  }
}

async function runDailyActivity() {
  if (accounts.length === 0) {
    addLog("No valid accounts found.", "error");
    return;
  }
  addLog(`Starting daily activity for all accounts. Auto Swap: ${dailyActivityConfig.swapRepetitions}x`, "info");
  activityRunning = true;
  isCycleRunning = true;
  shouldStop = false;
  hasLoggedSleepInterrupt = false;
  activeProcesses = Math.max(0, activeProcesses);
  updateMenu();
  try {
    for (let accountIndex = 0; accountIndex < accounts.length && !shouldStop; accountIndex++) {
      addLog(`Starting processing for account ${accountIndex + 1}`, "info");
      selectedWalletIndex = accountIndex;
      const proxyUrl = proxies[accountIndex % proxies.length] || null;
      addLog(`Account ${accountIndex + 1}: Using Proxy ${proxyUrl || "none"}`, "info");
      const wallet = new ethers.Wallet(accounts[accountIndex].privateKey);
      if (!ethers.isAddress(wallet.address)) {
        addLog(`Invalid wallet address for account ${accountIndex + 1}: ${wallet.address}`, "error");
        continue;
      }
      addLog(`Processing account ${accountIndex + 1}: ${getShortAddress(wallet.address)}`, "wait");

      await performCheckIn(wallet.address, proxyUrl);

      let directionIndex = 0;
      for (let swapCount = 0; swapCount < dailyActivityConfig.swapRepetitions && !shouldStop; swapCount++) {
        const currentDirection = swapDirections[directionIndex % swapDirections.length];
        let amount;
        if (currentDirection.from === "USDC") {
          amount = (Math.random() * (dailyActivityConfig.usdcSwapRange.max - dailyActivityConfig.usdcSwapRange.min) + dailyActivityConfig.usdcSwapRange.min).toFixed(3);
        } else if (currentDirection.from === "USDT") {
          amount = (Math.random() * (dailyActivityConfig.usdtSwapRange.max - dailyActivityConfig.usdtSwapRange.min) + dailyActivityConfig.usdtSwapRange.min).toFixed(3);
        }
        addLog(`Account ${accountIndex + 1} - Swap ${swapCount + 1}: ${amount} ${currentDirection.from} ➯ ${currentDirection.to}`, "warn");
        try {
          await performSwap(wallet, currentDirection, amount, proxyUrl);
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Swap ${swapCount + 1} (${currentDirection.from} ➯ ${currentDirection.to}): Failed: ${error.message}. Skipping.`, "error");
        } finally {
          await updateWallets();
        }

        directionIndex++;

        if (swapCount < dailyActivityConfig.swapRepetitions - 1 && !shouldStop) {
          const randomDelay = Math.floor(Math.random() * (25000 - 10000 + 1)) + 10000;
          addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before next swap...`, "delay");
          await sleep(randomDelay);
        }
      }

      if (accountIndex < accounts.length - 1 && !shouldStop) {
        addLog(`Waiting 10 seconds before next account...`, "delay");
        await sleep(10000);
      }
    }
    if (!shouldStop && activeProcesses <= 0) {
      addLog(`All accounts processed. Waiting ${dailyActivityConfig.loopHours} hours for next cycle.`, "success");
      dailyActivityInterval = setTimeout(runDailyActivity, dailyActivityConfig.loopHours * 60 * 60 * 1000);
    }
  } catch (error) {
    addLog(`Daily activity failed: ${error.message}`, "error");
  } finally {
    if (shouldStop) {
      if (activeProcesses <= 0) {
        if (dailyActivityInterval) {
          clearTimeout(dailyActivityInterval);
          dailyActivityInterval = null;
          addLog("Cleared daily activity interval.", "info");
        }
        activityRunning = false;
        isCycleRunning = false;
        shouldStop = false;
        hasLoggedSleepInterrupt = false;
        activeProcesses = 0;
        addLog("Daily activity stopped successfully.", "success");
        updateMenu();
        updateStatus();
        safeRender();
      } else {
        const stopCheckInterval = setInterval(() => {
          if (activeProcesses <= 0) {
            clearInterval(stopCheckInterval);
            if (dailyActivityInterval) {
              clearTimeout(dailyActivityInterval);
              dailyActivityInterval = null;
              addLog("Cleared daily activity interval.", "info");
            }
            activityRunning = false;
            isCycleRunning = false;
            shouldStop = false;
            hasLoggedSleepInterrupt = false;
            activeProcesses = 0;
            addLog("Daily activity stopped successfully.", "success");
            updateMenu();
            updateStatus();
            safeRender();
          } else {
            addLog(`Waiting for ${activeProcesses} process to complete...`, "info");
          }
        }, 1000);
      }
    } else {
      activityRunning = false;
      isCycleRunning = activeProcesses > 0 || dailyActivityInterval !== null;
      updateMenu();
      updateStatus();
      safeRender();
    }
    nonceTracker = {};
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "TEAFI AUTO BOT",
  autoPadding: true,
  fullUnicode: true,
  mouse: true,
  ignoreLocked: ["C-c", "q", "escape"]
});

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  height: 6,
  tags: true,
  style: { fg: "yellow", bg: "default" }
});

const statusBox = blessed.box({
  left: 0,
  top: 6,
  width: "100%",
  height: 3,
  tags: true,
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" } },
  content: "Status: Initializing...",
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  label: chalk.cyan(" Status "),
  wrap: true
});

const walletBox = blessed.list({
  label: " Wallet Information",
  top: 9,
  left: 0,
  width: "40%",
  height: "35%",
  border: { type: "line", fg: "cyan" },
  style: { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } },
  scrollable: true,
  scrollbar: { bg: "cyan", fg: "black" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  content: "Loading wallet data..."
});

const logBox = blessed.log({
  label: " Transaction Logs",
  top: 9,
  left: "41%",
  width: "59%",
  height: "100%-9",
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  tags: true,
  scrollbar: { ch: "│", style: { bg: "cyan", fg: "white" }, track: { bg: "gray" } },
  scrollback: 100,
  smoothScroll: true,
  style: { border: { fg: "magenta" }, bg: "default", fg: "white" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  wrap: true,
  focusable: true,
  keys: true
});

const menuBox = blessed.list({
  label: " Menu ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "magenta", fg: "black" }, item: { fg: "white" } },
  items: isCycleRunning
    ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"],
  padding: { left: 1, top: 1 }
});

const dailyActivitySubMenu = blessed.list({
  label: " Manual Config Options ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" },
    selected: { bg: "blue", fg: "black" },
    item: { fg: "white" }
  },
  items: [
    "Set Swap Repetitions",
    "Set USDC Swap Range",
    "Set USDT Swap Range",
    "Set Loop Daily",
    "Back to Main Menu"
  ],
  padding: { left: 1, top: 1 },
  hidden: true
});

const configForm = blessed.form({
  label: " Enter Config Value ",
  top: "center",
  left: "center",
  width: "30%",
  height: "40%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const minLabel = blessed.text({
  parent: configForm,
  top: 0,
  left: 1,
  content: "Min Value:",
  style: { fg: "white" }
});

const maxLabel = blessed.text({
  parent: configForm,
  top: 4,
  left: 1,
  content: "Max Value:",
  style: { fg: "white" }
});

const configInput = blessed.textbox({
  parent: configForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configInputMax = blessed.textbox({
  parent: configForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configSubmitButton = blessed.button({
  parent: configForm,
  top: 9,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  clickable: true,
  keys: true,
  mouse: true,
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green", border: { fg: "yellow" } }
  }
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(dailyActivitySubMenu);
screen.append(configForm);

let renderQueue = [];
let isRendering = false;
function safeRender() {
  renderQueue.push(true);
  if (isRendering) return;
  isRendering = true;
  setTimeout(() => {
    try {
      if (!isHeaderRendered) {
        figlet.text("NT EXHAUST", { font: "ANSI Shadow" }, (err, data) => {
          if (!err) headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
          isHeaderRendered = true;
        });
      }
      screen.render();
    } catch (error) {
      addLog(`UI render error: ${error.message}`, "error");
    }
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
  const screenHeight = screen.height || 24;
  const screenWidth = screen.width || 80;
  headerBox.height = Math.max(6, Math.floor(screenHeight * 0.15));
  statusBox.top = headerBox.height;
  statusBox.height = Math.max(3, Math.floor(screenHeight * 0.07));
  statusBox.width = screenWidth - 2;
  walletBox.top = headerBox.height + statusBox.height;
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  logBox.top = headerBox.height + statusBox.height;
  logBox.left = Math.floor(screenWidth * 0.41);
  logBox.width = screenWidth - walletBox.width - 2;
  logBox.height = screenHeight - (headerBox.height + statusBox.height);
  menuBox.top = headerBox.height + statusBox.height + walletBox.height;
  menuBox.width = Math.floor(screenWidth * 0.4);
  menuBox.height = screenHeight - (headerBox.height + statusBox.height + walletBox.height);

  if (menuBox.top != null) {
    dailyActivitySubMenu.top = menuBox.top;
    dailyActivitySubMenu.width = menuBox.width;
    dailyActivitySubMenu.height = menuBox.height;
    dailyActivitySubMenu.left = menuBox.left;
    configForm.width = Math.floor(screenWidth * 0.3);
    configForm.height = Math.floor(screenHeight * 0.4);
  }

  safeRender();
}

function updateStatus() {
  try {
    const isProcessing = activityRunning || (isCycleRunning && dailyActivityInterval !== null);
    const status = activityRunning
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}`
      : isCycleRunning && dailyActivityInterval !== null
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Waiting for next cycle")}`
      : chalk.green("Idle");
    const statusText = `Status: ${status} | Active Account: ${getShortAddress(walletInfo.address)} | Total Accounts: ${accounts.length} | Auto Swap: ${dailyActivityConfig.swapRepetitions}x | Loop: ${dailyActivityConfig.loopHours}h | TEAFI AUTO BOT`;
    statusBox.setContent(statusText);
    if (isProcessing) {
      if (blinkCounter % 1 === 0) {
        statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
        borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
      }
      blinkCounter++;
    } else {
      statusBox.style.border.fg = "cyan";
    }
    spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
    safeRender();
  } catch (error) {
    addLog(`Status update error: ${error.message}`, "error");
  }
}

async function updateWallets() {
  try {
    const walletData = await updateWalletData();
    const header = `${chalk.bold.cyan("  Address").padEnd(20)}           ${chalk.bold.cyan("POL".padEnd(6))}  ${chalk.bold.cyan("USDC".padEnd(6))}   ${chalk.bold.cyan("USDT".padEnd(6))}`;
    const separator = chalk.gray("-".repeat(100));
    walletBox.setItems([header, separator, ...walletData]);
    walletBox.select(0);
    safeRender();
  } catch (error) {
    addLog(`Failed to update wallet data: ${error.message}`, "error");
  }
}

function updateLogs() {
  try {
    logBox.add(transactionLogs[transactionLogs.length - 1] || chalk.gray("No logs available."));
    logBox.scrollTo(transactionLogs.length);
    safeRender();
  } catch (error) {
    addLog(`Log update failed: ${error.message}`, "error");
  }
}

function updateMenu() {
  try {
    menuBox.setItems(
      isCycleRunning
        ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
        : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    );
    safeRender();
  } catch (error) {
    addLog(`Menu update failed: ${error.message}`, "error");
  }
}

const statusInterval = setInterval(updateStatus, 100);

logBox.key(["up"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(-1);
    safeRender();
  }
});

logBox.key(["down"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(1);
    safeRender();
  }
});

logBox.on("click", () => {
  screen.focusPush(logBox);
  logBox.style.border.fg = "yellow";
  menuBox.style.border.fg = "red";
  dailyActivitySubMenu.style.border.fg = "blue";
  safeRender();
});

logBox.on("blur", () => {
  logBox.style.border.fg = "magenta";
  safeRender();
});

menuBox.on("select", async (item) => {
  const action = item.getText();
  switch (action) {
    case "Start Auto Daily Activity":
      if (isCycleRunning) {
        addLog("Cycle is still running. Stop the current cycle first.", "error");
      } else {
        await runDailyActivity();
      }
      break;
    case "Stop Activity":
      shouldStop = true;
      if (dailyActivityInterval) {
        clearTimeout(dailyActivityInterval);
        dailyActivityInterval = null;
        addLog("Cleared daily activity interval.", "info");
      }
      addLog("Stopping daily activity. Please wait for ongoing process to complete.", "info");
      safeRender();
      if (activeProcesses <= 0) {
        activityRunning = false;
        isCycleRunning = false;
        shouldStop = false;
        hasLoggedSleepInterrupt = false;
        addLog("Daily activity stopped successfully.", "success");
        updateMenu();
        updateStatus();
        safeRender();
      } else {
        const stopCheckInterval = setInterval(() => {
          if (activeProcesses <= 0) {
            clearInterval(stopCheckInterval);
            activityRunning = false;
            isCycleRunning = false;
            shouldStop = false;
            hasLoggedSleepInterrupt = false;
            activeProcesses = 0;
            addLog("Daily activity stopped successfully.", "success");
            updateMenu();
            updateStatus();
            safeRender();
          } else {
            addLog(`Waiting for ${activeProcesses} process(es) to complete...`, "info");
            safeRender();
          }
        }, 1000);
      }
      break;
    case "Set Manual Config":
      menuBox.hide();
      dailyActivitySubMenu.show();
      setTimeout(() => {
        if (dailyActivitySubMenu.visible) {
          screen.focusPush(dailyActivitySubMenu);
          dailyActivitySubMenu.style.border.fg = "yellow";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
    case "Clear Logs":
      clearTransactionLogs();
      break;
    case "Refresh":
      await updateWallets();
      addLog("Data refreshed.", "success");
      break;
    case "Exit":
      clearInterval(statusInterval);
      process.exit(0);
  }
});

dailyActivitySubMenu.on("select", (item) => {
  const action = item.getText();
  switch (action) {
    case "Set Swap Repetitions":
      configForm.configType = "swapRepetitions";
      configForm.setLabel(" Enter Swap Repetitions ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.swapRepetitions.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set USDC Swap Range":
      configForm.configType = "usdcSwapRange";
      configForm.setLabel(" Enter USDC Swap Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.usdcSwapRange.min.toString());
      configInputMax.setValue(dailyActivityConfig.usdcSwapRange.max.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set USDT Swap Range":
      configForm.configType = "usdtSwapRange";
      configForm.setLabel(" Enter USDT Swap Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.usdtSwapRange.min.toString());
      configInputMax.setValue(dailyActivityConfig.usdtSwapRange.max.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set Loop Daily":
      configForm.configType = "loopHours";
      configForm.setLabel(" Enter Loop Hours (Min 1 Hours) ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.loopHours.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Back to Main Menu":
      dailyActivitySubMenu.hide();
      menuBox.show();
      setTimeout(() => {
        if (menuBox.visible) {
          screen.focusPush(menuBox);
          menuBox.style.border.fg = "cyan";
          dailyActivitySubMenu.style.border.fg = "blue";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
  }
});

let isSubmitting = false;
configForm.on("submit", () => {
  if (isSubmitting) return;
  isSubmitting = true;

  const inputValue = configInput.getValue().trim();
  let value, maxValue;
  try {
    if (configForm.configType === "loopHours" || configForm.configType === "swapRepetitions") {
      value = parseInt(inputValue);
    } else {
      value = parseFloat(inputValue);
    }
    if (["usdcSwapRange", "usdtSwapRange"].includes(configForm.configType)) {
      maxValue = parseFloat(configInputMax.getValue().trim());
      if (isNaN(maxValue) || maxValue <= 0) {
        addLog("Invalid Max value. Please enter a positive number.", "error");
        configInputMax.clearValue();
        screen.focusPush(configInputMax);
        safeRender();
        isSubmitting = false;
        return;
      }
    }
    if (isNaN(value) || value <= 0) {
      addLog("Invalid input. Please enter a positive number.", "error");
      configInput.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    if (configForm.configType === "loopHours" && value < 1) {
      addLog("Invalid input. Minimum is 1 hour.", "error");
      configInput.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    configInput.clearValue();
    screen.focusPush(configInput);
    safeRender();
    isSubmitting = false;
    return;
  }

  if (configForm.configType === "swapRepetitions") {
    dailyActivityConfig.swapRepetitions = Math.floor(value);
    addLog(`Swap Repetitions set to ${dailyActivityConfig.swapRepetitions}`, "success");
  } else if (configForm.configType === "usdcSwapRange") {
    if (value > maxValue) {
      addLog("Min value cannot be greater than Max value.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    dailyActivityConfig.usdcSwapRange.min = value;
    dailyActivityConfig.usdcSwapRange.max = maxValue;
    addLog(`USDC Swap Range set to ${value} - ${maxValue}`, "success");
  } else if (configForm.configType === "usdtSwapRange") {
    if (value > maxValue) {
      addLog("Min value cannot be greater than Max value.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    dailyActivityConfig.usdtSwapRange.min = value;
    dailyActivityConfig.usdtSwapRange.max = maxValue;
    addLog(`USDT Swap Range set to ${value} - ${maxValue}`, "success");
  } else if (configForm.configType === "loopHours") {
    dailyActivityConfig.loopHours = value;
    addLog(`Loop Daily set to ${value} hours`, "success");
  }
  saveConfig();
  updateStatus();

  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
    isSubmitting = false;
  }, 100);
});

configInput.key(["enter"], () => {
  if (["usdcSwapRange", "usdtSwapRange"].includes(configForm.configType)) {
    screen.focusPush(configInputMax);
  } else {
    configForm.submit();
  }
});

configInputMax.key(["enter"], () => {
  configForm.submit();
});

configSubmitButton.on("press", () => {
  configForm.submit();
});

configSubmitButton.on("click", () => {
  screen.focusPush(configSubmitButton);
  configForm.submit();
});

configForm.key(["escape"], () => {
  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

dailyActivitySubMenu.key(["escape"], () => {
  dailyActivitySubMenu.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.style.border.fg = "cyan";
      dailyActivitySubMenu.style.border.fg = "blue";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

screen.key(["escape", "q", "C-c"], () => {
  addLog("Exiting application", "info");
  clearInterval(statusInterval);
  process.exit(0);
});

async function initialize() {
  try {
    loadConfig();
    loadAccounts();
    loadProxies();
    updateStatus();
    await updateWallets();
    updateLogs();
    safeRender();
    menuBox.focus();
  } catch (error) {
    addLog(`Initialization error: ${error.message}`, "error");
  }
}

setTimeout(() => {
  adjustLayout();
  screen.on("resize", adjustLayout);
}, 100);

initialize();