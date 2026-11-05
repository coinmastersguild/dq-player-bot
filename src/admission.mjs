// Adapted from the public DegenQuest admission validator; same V3 quote/ABI pins.
import {Interface,concat,getAddress,getBytes,keccak256,toUtf8Bytes,verifyTypedData,Transaction} from 'ethers';
export const GATE='0x7467B837967a605eBEaAAfDD973f76b8037240ba';
export const SIGNER='0x7E79501c7b927bD2De1de7A03A5F664111c0d879';
export const ABI=new Interface(['function purchaseFor(bytes32 orderKey,bytes32 beneficiarySubject,uint256 totalEthWei,uint256 swapEthWei,uint256 minGoldOut,uint256 goldToBurn,uint256 expiresAt,bytes quoteSignature) payable']);
export const TYPES={AdmissionQuoteV3:[{name:'orderKey',type:'bytes32'},{name:'beneficiarySubject',type:'bytes32'},{name:'totalEthWei',type:'uint256'},{name:'swapEthWei',type:'uint256'},{name:'minGoldOut',type:'uint256'},{name:'goldToBurn',type:'uint256'},{name:'expiresAt',type:'uint256'}]};
export const subject=(a)=>keccak256(concat([toUtf8Bytes('degenquest:alpha:v2'),new Uint8Array([1]),getBytes(getAddress(a))]));
export function purchaseTransaction(order,beneficiary,now=Date.now()){
 const p=order.payment,q=p.quoteV3;
 if(p.version!==3||p.chainId!==8453||getAddress(p.contract)!==GATE||!q||q.version!==3)throw new Error('The server returned an unsupported admission contract');
 if(getAddress(order.beneficiary.address)!==getAddress(beneficiary)||order.beneficiary.subject!==subject(beneficiary))throw new Error('The quote belongs to a different character owner');
 const expiresAt=Math.floor(new Date(p.expiresAt).getTime()/1000);
 if(!Number.isSafeInteger(expiresAt)||expiresAt<=Math.floor(now/1000))throw new Error('This quote expired. Refresh the price before paying.');
 for(const n of [q.totalEthWei,q.swapEthWei,q.minGoldOut,q.goldToBurn,q.targetUsdCents])if(!/^\d+$/.test(n)||BigInt(n)<=0n)throw new Error('Invalid quote amount');
 if(q.totalEthWei!==p.ethValueWei||q.goldToBurn!==p.minGoldBurn||BigInt(q.swapEthWei)>=BigInt(q.totalEthWei)||BigInt(q.goldToBurn)>=BigInt(q.minGoldOut))throw new Error('Inconsistent admission quote');
 const values={orderKey:order.orderKey,beneficiarySubject:order.beneficiary.subject,totalEthWei:q.totalEthWei,swapEthWei:q.swapEthWei,minGoldOut:q.minGoldOut,goldToBurn:q.goldToBurn,expiresAt};
 if(verifyTypedData({name:'DegenQuest Alpha Admission',version:'3',chainId:8453,verifyingContract:GATE},TYPES,values,p.quoteSignature)!==SIGNER)throw new Error('Invalid admission quote signature');
 return {chainId:8453,to:GATE,value:BigInt(q.totalEthWei),data:ABI.encodeFunctionData('purchaseFor',[...Object.values(values),p.quoteSignature])};
}
export function checkHardwareSignature(raw,expected,payer){
 const tx=Transaction.from(raw);
 if(tx.unsignedSerialized!==expected||!tx.from||getAddress(tx.from)!==getAddress(payer))throw new Error('KeepKey signed a different transaction');
 return tx;
}
export function validateBroadcast(raw){
 const tx=Transaction.from(raw);
 if(tx.chainId!==8453n||tx.to!==GATE||!tx.signature)throw new Error('Only signed Base V3 admission transactions may be relayed');
 const a=ABI.decodeFunctionData('purchaseFor',tx.data);
 const values={orderKey:a.orderKey,beneficiarySubject:a.beneficiarySubject,totalEthWei:a.totalEthWei,swapEthWei:a.swapEthWei,minGoldOut:a.minGoldOut,goldToBurn:a.goldToBurn,expiresAt:a.expiresAt};
 if(tx.value!==a.totalEthWei||verifyTypedData({name:'DegenQuest Alpha Admission',version:'3',chainId:8453,verifyingContract:GATE},TYPES,values,a.quoteSignature)!==SIGNER)throw new Error('Invalid signed admission transaction');
 return tx;
}
