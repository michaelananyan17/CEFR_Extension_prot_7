// Content script for text rewriting and summarization
let originalTexts = new Map();
let isRewritten = false;

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'rewritePage') {
        rewritePageContent(request.apiKey, request.targetLevel)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }
    
    if (request.action === 'summarizePage') {
        summarizePageContent(request.apiKey, request.targetLevel)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }
    
    if (request.action === 'resetPage') {
        resetPageContent();
        sendResponse({ success: true });
    }
    
    if (request.action === 'updateProgress') {
        // Could be used for progress updates in future
        sendResponse({ success: true });
    }
});

// ========== REWRITE PAGE FUNCTIONALITY ==========

// Main function to rewrite page content
async function rewritePageContent(apiKey, targetLevel) {
    try {
        // Store original texts if not already stored
        if (!isRewritten) {
            storeOriginalTexts();
        }
        
        // Send initial progress
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 10 });
        
        // Process each text element in parallel batches for maximum speed
        await rewriteTextElementsParallel(targetLevel, apiKey);
        
        isRewritten = true;
        
        // Send completion progress
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 100 });
        
        return { success: true, elementsRewritten: originalTexts.size };
        
    } catch (error) {
        console.error('Content rewriting error:', error);
        return { success: false, error: error.message };
    }
}

// NEW: Parallel processing with 10 concurrent threads
async function rewriteTextElementsParallel(targetLevel, apiKey) {
    const totalElements = originalTexts.size;
    const batchSize = 10; // Process 10 elements in parallel
    let processedElements = 0;
    
    // Convert Map to array for easier batch processing
    const elementsArray = Array.from(originalTexts.entries());
    
    // Process in batches of 10
    for (let i = 0; i < elementsArray.length; i += batchSize) {
        const batch = elementsArray.slice(i, i + batchSize);
        
        // Create promises for all elements in current batch
        const batchPromises = batch.map(async ([index, item]) => {
            const originalText = item.originalText;
            
            if (originalText.trim().length > 10) {
                try {
                    // Rewrite this specific text element
                    const rewrittenText = await rewriteTextWithOpenAI(originalText, targetLevel, apiKey);
                    
                    // Update progress for this batch
                    processedElements++;
                    const progress = 10 + Math.floor((processedElements / totalElements) * 80);
                    chrome.runtime.sendMessage({ action: 'progressUpdate', progress: progress });
                    
                    return { index, item, rewrittenText, success: true };
                } catch (error) {
                    console.error(`Error rewriting element ${index}:`, error);
                    return { index, item, rewrittenText: originalText, success: false };
                }
            } else {
                processedElements++;
                return { index, item, rewrittenText: originalText, success: true };
            }
        });
        
        // Wait for all promises in current batch to complete
        const batchResults = await Promise.allSettled(batchPromises);
        
        // Apply all successful rewrites from this batch
        batchResults.forEach(result => {
            if (result.status === 'fulfilled' && result.value.success) {
                const { index, item, rewrittenText } = result.value;
                replaceElementTextContent(item.element, rewrittenText);
            }
        });
        
        // Small delay between batches to avoid overwhelming the API
        if (i + batchSize < elementsArray.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}

// Get temperature based on CEFR level for enhanced level representation
function getTemperatureForLevel(targetLevel) {
    const temperatureMap = {
        'A1': 0.3,   // Low temperature for very predictable, simple outputs
        'A2': 0.4,   // Slightly more variation but still conservative
        'B1': 0.5,   // Balanced for intermediate complexity
        'B2': 0.6,   // More creative for upper intermediate
        'C1': 0.75,  // High creativity for advanced vocabulary
        'C2': 0.9    // Very high for sophisticated, complex outputs
    };
    return temperatureMap[targetLevel] || 0.5;
}

// Get enhanced level-specific instructions
function getEnhancedLevelInstructions(targetLevel) {
    const instructions = {
        'A1': `USE VERY SIMPLE LANGUAGE:
- Use only basic vocabulary (most common 500-800 words)
- Maximum sentence length: 8-10 words
- Simple present tense preferred
- Avoid complex sentence structures
- Use basic conjunctions: and, but, or
- Repeat key concepts for clarity`,

        'A2': `USE ELEMENTARY LANGUAGE:
- Common everyday vocabulary (800-1500 words)
- Simple sentence structures
- Basic past and future tenses
- Short to medium length sentences
- Clear, direct communication`,

        'B1': `USE INTERMEDIATE LANGUAGE:
- General vocabulary (1500-2500 words)
- Some compound sentences
- Variety of tenses and structures
- Can express opinions and explanations
- Moderate sentence complexity`,

        'B2': `USE UPPER INTERMEDIATE LANGUAGE:
- Broad vocabulary including some abstract terms
- Complex sentence structures
- Appropriate use of linking words
- Can discuss technical topics
- Nuanced expression`,

        'C1': `USE ADVANCED LANGUAGE:
- Sophisticated vocabulary and idioms
- Complex grammatical structures
- Precise and fluent expression
- Academic and professional language
- Subtle nuances and implications`,

        'C2': `USE PROFICIENCY-LEVEL LANGUAGE:
- Highly sophisticated vocabulary including rare words
- Very complex sentence structures
- Native-like fluency and precision
- Literary and technical mastery
- Cultural references and wordplay where appropriate`
    };
    return instructions[targetLevel] || 'Use appropriate language for the specified level.';
}

// Enhanced text rewriting with dynamic parameters based on CEFR level
async function rewriteTextWithOpenAI(text, targetLevel, apiKey) {
    // Clean the text for processing
    const cleanText = text.trim().replace(/\s+/g, ' ').substring(0, 2000);
    
    const temperature = getTemperatureForLevel(targetLevel);
    const levelInstructions = getEnhancedLevelInstructions(targetLevel);
    
    const prompt = `Rewrite the following text to STRONGLY REPRESENT CEFR level ${targetLevel} English. 
    
CRITICAL RULES:
- ${levelInstructions}
- EXAGGERATE the level characteristics to make it clearly ${targetLevel}
- Keep the exact same meaning and context
- Return ONLY the rewritten text, no explanations
- Preserve any proper nouns, names, or technical terms
- Keep the same overall length
- DO NOT CHANGE any text that appears within quotation marks ("..."). Keep quoted text exactly as it appears in the original.

CEFR ${targetLevel} Guidelines: ${getLevelGuidelines(targetLevel)}

Original text: "${cleanText}"

Rewritten text (STRONGLY representing ${targetLevel} level):`;

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-3.5-turbo',
                messages: [
                    {
                        role: 'system',
                        content: `You are a professional text rewriter that STRONGLY adapts content to specific CEFR English levels. You must EXAGGERATE the level characteristics to make the ${targetLevel} level very clear and distinct. You MUST preserve all text within quotation marks exactly as it appears in the original, without any changes.`
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                max_tokens: Math.min(2500, cleanText.length * 2),
                temperature: temperature,
                top_p: 0.9, // Using top-p sampling for better diversity
                frequency_penalty: 0.1,
                presence_penalty: 0.1
            })
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API Error: ${errorData.error?.message || 'Unknown error'}`);
        }
        
        const data = await response.json();
        const rewrittenText = data.choices[0].message.content.trim();
        
        if (!rewrittenText) {
            throw new Error('OpenAI returned empty response');
        }
        
        return rewrittenText;
        
    } catch (error) {
        console.error('OpenAI API Error:', error);
        return text; // Return original text if API fails
    }
}

// Replace element text content while preserving all HTML structure and styling
function replaceElementTextContent(element, newText) {
    // Store original styles and classes
    const originalClass = element.className;
    const originalStyle = element.style.cssText;
    const originalAttributes = {};
    
    // Store important attributes
    ['id', 'style', 'class', 'data-*'].forEach(attr => {
        if (element.hasAttribute(attr)) {
            originalAttributes[attr] = element.getAttribute(attr);
        }
    });
    
    // Create smooth transition
    element.style.transition = 'opacity 0.3s ease';
    element.style.opacity = '0.7';
    
    setTimeout(() => {
        // Replace text content while preserving child elements if they exist
        if (element.childNodes.length === 1 && element.childNodes[0].nodeType === Node.TEXT_NODE) {
            // Simple case: element only contains text
            element.textContent = newText;
        } else {
            // Complex case: element contains other HTML elements
            // Find and replace the main text content while preserving child elements
            const textNodes = getTextNodes(element);
            if (textNodes.length > 0) {
                // Replace the primary text node (usually the first substantial one)
                let mainTextNode = textNodes.find(node => 
                    node.textContent.trim().length > 10 && 
                    !node.parentElement.tagName.match(/^(SCRIPT|STYLE|NOSCRIPT)$/i)
                ) || textNodes[0];
                
                if (mainTextNode) {
                    mainTextNode.textContent = newText;
                    
                    // Remove other insignificant text nodes to avoid duplicates
                    textNodes.forEach(node => {
                        if (node !== mainTextNode && node.textContent.trim().length < 5) {
                            node.parentNode.removeChild(node);
                        }
                    });
                } else {
                    // Fallback: clear and add new text
                    const textNode = document.createTextNode(newText);
                    element.innerHTML = '';
                    element.appendChild(textNode);
                }
            } else {
                // No text nodes found, append new text
                const textNode = document.createTextNode(newText);
                element.innerHTML = '';
                element.appendChild(textNode);
            }
        }
        
        // Restore original styles and classes
        element.className = originalClass;
        element.style.cssText = originalStyle;
        
        // Restore attributes
        Object.keys(originalAttributes).forEach(attr => {
            element.setAttribute(attr, originalAttributes[attr]);
        });
        
        element.style.opacity = '1';
    }, 150);
}

// ========== SUMMARIZE PAGE FUNCTIONALITY ==========

// Main function to summarize page content
async function summarizePageContent(apiKey, targetLevel) {
    try {
        // Extract main content from the page
        const textContent = extractMainContent();
        
        if (!textContent.trim()) {
            throw new Error('No readable text content found on this page');
        }
        
        // Create summary
        const summary = await createSummary(textContent, targetLevel, apiKey);
        
        // Download as text file instead of PDF to avoid binary issues
        downloadSummaryAsText(summary, targetLevel);
        
        return { success: true, summaryLength: summary.length };
        
    } catch (error) {
        console.error('Content summarization error:', error);
        return { success: false, error: error.message };
    }
}

// Create summary using OpenAI with enhanced level representation
async function createSummary(textContent, targetLevel, apiKey) {
    const wordCount = textContent.split(/\s+/).length;
    const targetWordCount = wordCount > 500 ? '500-600' : 'maximum 100';
    const temperature = getTemperatureForLevel(targetLevel);
    
    const prompt = `Create a ${targetWordCount} word summary of the following text at CEFR ${targetLevel} level. STRONGLY represent the ${targetLevel} level characteristics in your summary.

${getEnhancedLevelInstructions(targetLevel)}

Text to summarize:
"${textContent.substring(0, 12000)}"

Summary (STRONGLY representing ${targetLevel} level):`;

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-3.5-turbo',
                messages: [
                    {
                        role: 'system',
                        content: `You are a professional summarizer that creates concise summaries while STRONGLY representing specific CEFR English levels. Exaggerate the level characteristics to make them very clear.`
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                max_tokens: 800,
                temperature: temperature,
                top_p: 0.9
            })
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API Error: ${errorData.error?.message || 'Unknown error'}`);
        }
        
        const data = await response.json();
        return data.choices[0].message.content.trim();
        
    } catch (error) {
        console.error('OpenAI Summary Error:', error);
        throw new Error(`Failed to create summary: ${error.message}`);
    }
}

// Download summary as text file (fix for PDF binary issue)
function downloadSummaryAsText(summary, targetLevel) {
    const websiteName = document.title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
    const filename = `${websiteName}_${targetLevel}_summary.txt`;
    
    // Create text content with proper formatting
    const textContent = `
PAGE SUMMARY
============

Source: ${document.title}
URL: ${window.location.href}
CEFR Level: ${targetLevel}
Generated: ${new Date().toLocaleString()}

SUMMARY:
${summary}

---
Generated by Make it easy! Chrome Extension
    `;
    
    // Create blob and download
    const blob = new Blob([textContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// ========== UTILITY FUNCTIONS ==========

// Store original text content with better element selection
function storeOriginalTexts() {
    originalTexts.clear();
    
    // More selective element targeting to preserve layout
    const textElements = document.querySelectorAll(`
        p, h1, h2, h3, h4, h5, h6,
        article p, article h1, article h2, article h3,
        section p, section h1, section h2, section h3,
        .content p, .content h1, .content h2, .content h3,
        .article p, .article h1, .article h2, .article h3,
        .post p, .post h1, .post h2, .post h3,
        [role="article"] p, [role="article"] h1, [role="article"] h2,
        main p, main h1, main h2, main h3,
        div:not(nav):not(header):not(footer):not([class*="nav"]):not([class*="menu"]):not([class*="sidebar"])
    `);
    
    let index = 0;
    textElements.forEach((element) => {
        if (element.textContent && 
            element.textContent.trim().length > 25 && 
            isVisible(element) &&
            !isInNav(element) &&
            !isInteractive(element)) {
            originalTexts.set(index, {
                element: element,
                originalText: element.textContent,
                originalHTML: element.innerHTML
            });
            index++;
        }
    });
}

// Check if element is visible
function isVisible(element) {
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && 
           style.visibility !== 'hidden' && 
           style.opacity !== '0' &&
           element.offsetWidth > 0 &&
           element.offsetHeight > 0;
}

// Check if element is in navigation
function isInNav(element) {
    return element.closest('nav, .nav, .navigation, .menu, header, .header, footer, .footer, aside, .sidebar');
}

// Check if element is interactive
function isInteractive(element) {
    return element.tagName === 'BUTTON' || 
           element.tagName === 'A' ||
           element.getAttribute('role') === 'button' ||
           element.onclick != null;
}

// Extract main content from the page
function extractMainContent() {
    const contentSelectors = [
        'main',
        'article',
        '[role="main"]',
        '.content',
        '.main-content',
        '.post-content',
        '.article-content',
        '.story-content',
        '.entry-content'
    ];
    
    let mainContent = '';
    
    // Try to find main content containers first
    for (const selector of contentSelectors) {
        const element = document.querySelector(selector);
        if (element && getTextContentLength(element) > 100) {
            mainContent = element.textContent;
            break;
        }
    }
    
    // If no main content found, use body text but exclude navigation
    if (!mainContent || mainContent.length < 100) {
        const body = document.body.cloneNode(true);
        
        // Remove common navigation and non-content elements
        const excludeSelectors = [
            'nav', 'header', 'footer', '.nav', '.header', '.footer', 
            '.menu', '.sidebar', '.ad', '.advertisement', '.banner',
            'script', 'style', 'noscript', 'iframe'
        ];
        excludeSelectors.forEach(selector => {
            const elements = body.querySelectorAll(selector);
            elements.forEach(el => el.remove());
        });
        
        mainContent = body.textContent;
    }
    
    // Clean up the text
    return cleanTextContent(mainContent);
}

// Get text content length
function getTextContentLength(element) {
    return element.textContent.replace(/\s+/g, ' ').trim().length;
}

// Clean text content
function cleanTextContent(text) {
    return text
        .replace(/\s+/g, ' ')
        .replace(/\n+/g, '\n')
        .trim()
        .substring(0, 12000); // Limit to avoid token limits
}

// Get CEFR level guidelines
function getLevelGuidelines(level) {
    const guidelines = {
        'A1': 'Use very basic phrases and simple vocabulary. Short sentences. Everyday expressions.',
        'A2': 'Use basic sentences and common vocabulary. Direct communication about familiar topics.',
        'B1': 'Use clear standard language. Can handle main points on familiar topics. Straightforward connected text.',
        'B2': 'Use more complex sentences and vocabulary. Can handle abstract and technical topics.',
        'C1': 'Use sophisticated language and complex structures. Fluent and precise expression.',
        'C2': 'Use highly sophisticated language with nuance and precision. Native-like fluency.'
    };
    
    return guidelines[level] || 'Use appropriate language for the specified level.';
}

// Get text nodes from an element
function getTextNodes(element) {
    const textNodes = [];
    
    function findTextNodes(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            textNodes.push(node);
        } else {
            node.childNodes.forEach(findTextNodes);
        }
    }
    
    findTextNodes(element);
    return textNodes;
}

// Reset page to original content
function resetPageContent() {
    if (!isRewritten) return;
    
    originalTexts.forEach(item => {
        item.element.innerHTML = item.originalHTML;
    });
    
    isRewritten = false;
    
    // Smooth transition
    document.body.style.transition = 'opacity 0.3s ease';
    document.body.style.opacity = '0.8';
    setTimeout(() => {
        document.body.style.opacity = '1';
    }, 300);
}
