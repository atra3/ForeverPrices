local _, addon = ...
ForeverPrices = addon

local function matchingHouse()
    local realm = string.lower(GetRealmName() or "")
    return GetCurrentRegion() == 1 and UnitFactionGroup("player") == "Horde"
        and realm:find("pvp", 1, true) and not realm:find("rp", 1, true)
        and not realm:find("roleplay", 1, true)
end

-- Copper per unit. Equipment is grouped by base item ID, like the site's free view.
function addon.GetPrice(itemID)
    if not matchingHouse() then return end
    local p = addon.prices[itemID]
    if p then return p[1], p[2], p[3], addon.updated end
end

TooltipDataProcessor.AddTooltipPostCall(Enum.TooltipDataType.Item, function(tooltip, data)
    if tooltip ~= GameTooltip and tooltip ~= ItemRefTooltip then return end
    local minimum, quartile, median, updated = addon.GetPrice(data.id)
    if not minimum then return end
    local age = math.max(0, time() - updated)
    local ageText = age < 3600 and (math.floor(age / 60) .. "m")
        or (math.floor(age / 3600) .. "h")
    tooltip:AddLine("Undermine · " .. ageText, 0.65, 0.65, 0.65)
    tooltip:AddDoubleLine("Min buyout", C_CurrencyInfo.GetCoinTextureString(minimum, 12), 0.9, 0.8, 0.5, 1, 1, 1)
    tooltip:AddDoubleLine("25% buyout", C_CurrencyInfo.GetCoinTextureString(quartile, 12), 0.9, 0.8, 0.5, 1, 1, 1)
    tooltip:AddDoubleLine("Median buyout", C_CurrencyInfo.GetCoinTextureString(median, 12), 0.9, 0.8, 0.5, 1, 1, 1)
end)
