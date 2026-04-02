export class AptPkgReducer {
    family = "apt-pkg";
    reduce(input) {
        const raw = input.raw;
        const lines = raw.split("\n");
        const errors = [];
        let upgraded = 0;
        let removed = 0;
        let fetched = "";
        for (const line of lines) {
            const t = line.trim();
            if (/^E:\s|^Error:|Unable to locate package|conflicting packages|broken package|NO_PUBKEY|nothing provides/i.test(t)) {
                errors.push(t.slice(0, 220));
            }
            else if (/^Upgrading\s/i.test(t) || /^Upgrade\s+\d+/i.test(t))
                upgraded++;
            else if (/^Removing\s|^  Removing /i.test(t))
                removed++;
            else if (/^Fetched\s+[\d.]+\s*(MB|kB|GB)/i.test(t)) {
                const m = t.match(/Fetched\s+([\d.]+\s*(?:MB|kB|GB)[^\n]*)/i);
                if (m)
                    fetched = m[1].trim();
            }
        }
        const settingUp = (raw.match(/^Setting up\s/gm) || []).length;
        const unpacking = (raw.match(/^Unpacking\s/gm) || []).length;
        const aptInstallCount = Math.max(settingUp, unpacking);
        const dnfInstall = raw.match(/Install\s+(\d+)\s+Package/i);
        const dnfUpgrade = raw.match(/Upgrade\s+(\d+)\s+Package/i);
        let dnfCount = 0;
        if (dnfInstall)
            dnfCount += parseInt(dnfInstall[1], 10);
        if (dnfUpgrade)
            dnfCount += parseInt(dnfUpgrade[1], 10);
        let dnfInstallingLines = 0;
        let inInstalling = false;
        for (const line of lines) {
            const t = line.trim();
            if (/^Installing:\s*$/i.test(t)) {
                inInstalling = true;
                continue;
            }
            if (inInstalling && /^\S+\s+(x86_64|aarch64|arm64|noarch)\s+/.test(t))
                dnfInstallingLines++;
            if (inInstalling && /^Transaction Summary/i.test(t))
                inInstalling = false;
        }
        const pouring = (raw.match(/^==>\s*Pouring\b/gm) || []).length;
        const brewInstalled = raw.match(/(\d+)\s+formulae?\s+installed/i);
        const brewCask = raw.match(/(\d+)\s+casks?\s+installed/i);
        let brewCount = pouring;
        if (brewInstalled)
            brewCount = Math.max(brewCount, parseInt(brewInstalled[1], 10));
        if (brewCask)
            brewCount = Math.max(brewCount, parseInt(brewCask[1], 10));
        const looksApt = /^Get:\d+\s|^Unpacking\s|^Setting up\s|^Processing triggers for/i.test(raw) ||
            /^Reading package lists/i.test(raw);
        const looksDnf = /Transaction Summary|Total download size:|^Installing:\s*$/im.test(raw) && /(dnf|yum)\s/i.test(raw);
        const looksBrew = /^==>\s*(Downloading|Pouring|Caveats|Summary)/m.test(raw);
        const installedCount = Math.max(aptInstallCount, dnfCount || dnfInstallingLines, brewCount);
        if (!looksApt && !looksDnf && !looksBrew && errors.length === 0) {
            return null;
        }
        const installedN = Math.max(installedCount, looksBrew || looksDnf ? (installedCount || 1) : 0);
        const errN = errors.length;
        const limit = input.context.profile === "ultra" ? 3 : 6;
        const parts = [`<TOOL_REDUCED family="apt-pkg" installed="${installedN}" errors="${errN}">`];
        if (fetched)
            parts.push(`download: ${fetched}`);
        if (upgraded > 0)
            parts.push(`upgraded: ${upgraded}`);
        if (removed > 0)
            parts.push(`removed: ${removed}`);
        if (errors.length > 0) {
            parts.push("errors:");
            errors.slice(0, limit).forEach((e) => parts.push(`  ${e}`));
            if (errors.length > limit)
                parts.push(`  ... ${errors.length - limit} more`);
        }
        parts.push("</TOOL_REDUCED>");
        return {
            family: this.family,
            confidence: 0.87,
            actionableCount: errN,
            summary: parts.join("\n")
        };
    }
}
